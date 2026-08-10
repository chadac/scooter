// The ownership cache: a conversationId -> hostPod map kept fresh by a k8s WATCH on the
// Conversation CRD (one long-lived streaming connection, not per-request API calls). A
// dynamic watch is lighter than the full informer factory for a single small CRD.
package main

import (
	"context"
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

// OwnershipCache maps conversationId -> hostPod, updated from the CRD watch.
type OwnershipCache struct {
	mu    sync.RWMutex
	hosts map[string]string
}

func NewOwnershipCache() *OwnershipCache {
	return &OwnershipCache{hosts: map[string]string{}}
}

// Host returns the assigned hostPod for a conversation, or ("", false) if unknown/unassigned.
func (c *OwnershipCache) Host(convID string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	h, ok := c.hosts[convID]
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
			convID, host := hostFrom(&list.Items[i])
			c.set(convID, host)
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
			convID, host := hostFrom(obj)
			switch ev.Type {
			case "DELETED":
				c.delete(convID)
			default: // ADDED, MODIFIED
				c.set(convID, host)
			}
		}
		w.Stop()
		// Channel closed (watch expired) — loop re-lists + re-watches.
	}
}

// hostFrom pulls (name, status.hostPod) from a Conversation object.
func hostFrom(obj *unstructured.Unstructured) (convID, host string) {
	convID = obj.GetName()
	host, _, _ = unstructuredNestedString(obj.Object, "status", "hostPod")
	return convID, host
}
