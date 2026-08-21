// The ownership cache: a conversationId -> hostPod map kept fresh by a k8s WATCH on the
// Conversation CRD (one long-lived streaming connection, not per-request API calls). A
// dynamic watch is lighter than the full informer factory for a single small CRD.
package main

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

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
}

func NewOwnershipCache() *OwnershipCache {
	return &OwnershipCache{hosts: map[string]string{}, aliases: map[string]string{}}
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
	ri := dyn.Resource(conversationGVR).Namespace(namespace)
	for ctx.Err() == nil {
		// Seed from a full list (so we don't route blind before the first watch event).
		list, err := ri.List(ctx, metav1ListOptions())
		if err != nil {
			logf("cache list failed: %v", err)
			sleep(ctx, 2*time.Second)
			continue
		}
		for i := range list.Items {
			c.observe(&list.Items[i])
		}
		// Watch from the list's resourceVersion onward.
		w, err := ri.Watch(ctx, metav1WatchOptions(list.GetResourceVersion()))
		if err != nil {
			logf("cache watch failed: %v", err)
			sleep(ctx, 2*time.Second)
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
		// Channel closed (watch expired) — loop re-lists + re-watches.
	}
}

// Hosts returns every DISTINCT owner pod IP the cache currently knows about — i.e. the set of
// agent-host pods that own at least one conversation. Used by the fleet-aggregate fan-out
// (aggregate.go): a request that must see ALL conversations is sent to each of these and merged.
//
// Sourced from the Conversation CRs the cache already watches, so this needs no extra RBAC and no
// pod listing. A pod hosting nothing contributes nothing to a conversation list anyway, so its
// absence here is correct rather than a gap.
func (c *OwnershipCache) Hosts() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	seen := make(map[string]struct{}, len(c.hosts))
	out := make([]string, 0, len(c.hosts))
	for _, ip := range c.hosts {
		if ip == "" {
			continue
		}
		if _, dup := seen[ip]; dup {
			continue
		}
		seen[ip] = struct{}{}
		out = append(out, ip)
	}
	sort.Strings(out) // deterministic order → stable merge + reproducible tests
	return out
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
