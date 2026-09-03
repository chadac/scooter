// The ownership cache: a conversationId -> hostPod map kept fresh by a k8s WATCH on the
// Conversation CRD (one long-lived streaming connection, not per-request API calls). A
// dynamic watch is lighter than the full informer factory for a single small CRD.
package main

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// watchRetryDelay is the backoff between a failed list/watch and the next attempt. Named so the
// log line can report it as retry_in_ms instead of hiding it in prose.
const watchRetryDelay = 2 * time.Second

var conversationGVR = schema.GroupVersionResource{
	Group:    "scooter.chadac.dev",
	Version:  "v1alpha1",
	Resource: "conversations",
}

// OwnershipCache maps conversationId -> owner pod IP (status.hostIP), updated from the
// CRD watch. The IP is the routing address (Deployments give random pods no stable DNS).
//
// A conversation has TWO id-spaces: the thread UUID (the CR name — what the UI and webhooks
// use) and the sandbox SHORT-ID (`conv-<shortId>` in spec.sandboxRef — all the BROKER ever
// knows, since it derives everything from the sandbox SA name `sandbox-{shortId}`). BOTH are
// indexed here so either address resolves to the same owner. Indexing only the UUID meant a
// broker-addressed request — notably the AWS approval notify, POST /conversations/<shortId>/aws-request
// — missed the cache and fell back to a RANDOM ready pod; on a non-owner the raise was silently
// dropped and the user's Approve button never appeared. Mirrors the agent-host's own dual
// resolution (get(id) ?? getByShortId(id)).
type OwnershipCache struct {
	mu    sync.RWMutex
	hosts map[string]string // convID (thread UUID) -> hostIP
	// aliases: short-id -> thread UUID. Kept as an indirection (rather than a second
	// short-id -> IP map) so an owner change updates one entry and can't leave the two
	// views disagreeing about who owns the conversation.
	aliases map[string]string
	// crs: convID -> the CR fields the conversation LIST needs (existence, phase→status,
	// sandboxRef). The router serves GET /conversations by joining this (existence + status)
	// with the Postgres metadata; the CR is the source of truth for EXISTENCE, so a metadata
	// row without a CR here is an ended conversation and is omitted. Kept fresh by the same
	// watch that maintains hosts/aliases.
	crs map[string]crInfo
}

// crInfo is the per-conversation CR state the list join reads: phase drives status, sandboxRef
// supplies the sandbox name in the row projection.
type crInfo struct {
	phase      string
	sandboxRef string
}

// CRInfo is one conversation's CR state, id included, for enumeration by the list assembler.
type CRInfo struct {
	ID         string
	Phase      string
	SandboxRef string
}

func NewOwnershipCache() *OwnershipCache {
	return &OwnershipCache{
		hosts:   map[string]string{},
		aliases: map[string]string{},
		crs:     map[string]crInfo{},
	}
}

// CR returns one conversation's CR state, or ("", false) when no CR is known — i.e. the
// conversation does not exist (never created, or ended). The LISTEN loop uses this to honour the
// EXISTENCE rule for a single upsert: a metadata row whose CR the cache has not observed is not
// pushed (the snapshot/poll picks it up once the watch catches the CR).
func (c *OwnershipCache) CR(id string) (CRInfo, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	info, ok := c.crs[id]
	if !ok {
		return CRInfo{}, false
	}
	return CRInfo{ID: id, Phase: info.phase, SandboxRef: info.sandboxRef}, true
}

// HostIP returns the assigned owner pod IP for a conversation, or ("", false) if
// unknown/unassigned (caller then uses the ClusterIP fallback).
func (c *OwnershipCache) HostIP(convID string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	h, ok := c.hosts[convID]
	if !ok {
		// Not a thread UUID — try it as a sandbox short-id (how the broker addresses us).
		if uuid, isAlias := c.aliases[convID]; isAlias {
			h, ok = c.hosts[uuid]
		}
	}
	return h, ok && h != ""
}

func (c *OwnershipCache) set(convID, host string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if host == "" {
		delete(c.hosts, convID)
	} else {
		c.hosts[convID] = host
	}
}

func (c *OwnershipCache) delete(convID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.hosts, convID)
}

// observe records an ADDED/MODIFIED Conversation: the owner IP under the thread UUID, plus the
// short-id alias so a broker-addressed request lands on that same owner instead of the fallback.
func (c *OwnershipCache) observe(obj *unstructured.Unstructured) {
	convID, host := hostFrom(obj)
	if convID == "" {
		return
	}
	short := shortIDFrom(obj)
	c.mu.Lock()
	defer c.mu.Unlock()
	// The CR exists (ADDED/MODIFIED), so record it for the list join regardless of whether an
	// owner IP is assigned yet — existence and status don't depend on assignment.
	c.crs[convID] = crInfo{phase: phaseFrom(obj), sandboxRef: sandboxRefFrom(obj)}
	if host == "" {
		delete(c.hosts, convID)
	} else {
		c.hosts[convID] = host
	}
	if short == "" {
		return
	}
	if host == "" {
		// Unassigned: drop the alias too, so it can't outlive the mapping it stands for and
		// keep pointing broker traffic at a pod that no longer owns this conversation.
		delete(c.aliases, short)
		return
	}
	c.aliases[short] = convID
}

// forget drops a DELETED Conversation from BOTH indexes. Clearing the UUID but leaving the
// short-id alias behind would be worse than a plain miss: a miss falls back to a ready pod,
// whereas a stale alias keeps routing the broker's notifies into a black hole.
func (c *OwnershipCache) forget(obj *unstructured.Unstructured) {
	convID, _ := hostFrom(obj)
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.hosts, convID)
	delete(c.crs, convID) // the conversation ended — drop it from the existence set

	// Drop every alias pointing at this conversation. Sweeping by owner (rather than only the
	// short-id in this payload) covers a DELETE event whose object arrives without spec.
	for alias, owner := range c.aliases {
		if owner == convID {
			delete(c.aliases, alias)
		}
	}
}

// Run keeps the cache in sync: LIST to seed, then WATCH for changes, reconnecting on
// error. Blocks until ctx is cancelled. The status.hostPod field is what we track.
func (c *OwnershipCache) Run(ctx context.Context, dyn dynamic.Interface, namespace string) {
	log := logger("cache")
	ri := dyn.Resource(conversationGVR).Namespace(namespace)
	for ctx.Err() == nil {
		// Seed from a full list (so we don't route blind before the first watch event).
		list, err := ri.List(ctx, metav1ListOptions())
		if err != nil {
			if ctx.Err() != nil {
				return // shutting down; a cancelled list is not a failure
			}
			// "(retrying in 2s)" was prose; it is a field now.
			log.Error("conversation list failed",
				slog.String("namespace", namespace),
				slog.Int("retry_in_ms", int(watchRetryDelay.Milliseconds())),
				errAttr(err))
			sleep(ctx, watchRetryDelay)
			continue
		}
		log.Debug("cache seeded",
			slog.String("namespace", namespace),
			slog.Int("conversations", len(list.Items)))
		for i := range list.Items {
			c.observe(&list.Items[i])
		}
		// Watch from the list's resourceVersion onward.
		w, err := ri.Watch(ctx, metav1WatchOptions(list.GetResourceVersion()))
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Error("conversation watch failed",
				slog.String("namespace", namespace),
				slog.Int("retry_in_ms", int(watchRetryDelay.Milliseconds())),
				errAttr(err))
			sleep(ctx, watchRetryDelay)
			continue
		}
		for ev := range w.ResultChan() {
			obj, ok := ev.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			switch ev.Type {
			case "DELETED":
				c.forget(obj)
			default: // ADDED, MODIFIED
				c.observe(obj)
			}
		}
		w.Stop()
		// Channel closed (watch expired) — loop re-lists + re-watches. Routine k8s behaviour,
		// not a failure: debug.
		log.Debug("watch channel closed, re-listing", slog.String("namespace", namespace))
	}
}

// hostFrom pulls (name, status.hostIP) from a Conversation object. The IP is the routing
// address; we track it (not the pod name) because the router proxies straight to the pod IP.
func hostFrom(obj *unstructured.Unstructured) (convID, hostIP string) {
	convID = obj.GetName()
	hostIP, _, _ = unstructuredNestedString(obj.Object, "status", "hostIP")
	return convID, hostIP
}

// shortIDFrom derives the sandbox SHORT-ID from spec.sandboxRef (`conv-<shortId>`) — the id the
// broker addresses conversations by, since it only ever sees the sandbox SA name `sandbox-{shortId}`.
// Returns "" when the ref is absent (not provisioned yet) or lacks the `conv-` prefix: an
// unprefixed ref is not a short-id, and indexing an empty or bogus alias would shadow unrelated
// lookups and misroute them to the wrong owner.
func shortIDFrom(obj *unstructured.Unstructured) string {
	ref, _, _ := unstructuredNestedString(obj.Object, "spec", "sandboxRef")
	if !strings.HasPrefix(ref, "conv-") {
		return ""
	}
	return strings.TrimPrefix(ref, "conv-")
}

// phaseFrom reads status.phase (Pending|Assigned|Suspended|Orphaned) — the field the list maps
// to a conversation status. "" until the controller writes it.
func phaseFrom(obj *unstructured.Unstructured) string {
	phase, _, _ := unstructuredNestedString(obj.Object, "status", "phase")
	return phase
}

// sandboxRefFrom reads spec.sandboxRef verbatim (`conv-<shortId>`) — the sandbox name the list
// row projects. "" until the sandbox is provisioned.
func sandboxRefFrom(obj *unstructured.Unstructured) string {
	ref, _, _ := unstructuredNestedString(obj.Object, "spec", "sandboxRef")
	return ref
}
