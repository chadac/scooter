package main

import (
	"net/http/httptest"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// convCR builds a Conversation CR the way the controller writes it: metadata.name is the
// thread UUID, spec.sandboxRef is `conv-<shortId>`, status.hostIP is the owner pod.
func convCR(name, sandboxRef, hostIP string) *unstructured.Unstructured {
	o := map[string]interface{}{
		"metadata": map[string]interface{}{"name": name},
		"spec":     map[string]interface{}{},
		"status":   map[string]interface{}{},
	}
	if sandboxRef != "" {
		o["spec"].(map[string]interface{})["sandboxRef"] = sandboxRef
	}
	if hostIP != "" {
		o["status"].(map[string]interface{})["hostIP"] = hostIP
	}
	return &unstructured.Unstructured{Object: o}
}

// The broker addresses its approval-notify by the sandbox SHORT-ID (it only ever knows
// `sandbox-{shortId}`), so a cache indexed by the thread UUID alone MISSES and the request
// falls back to a random ready pod — where the raise is silently dropped and the user never
// sees an Approve button. Both ids must resolve to the same owner.
func TestHostFromIndexesShortIDAndUUID(t *testing.T) {
	c := NewOwnershipCache()
	c.observe(convCR("5e1949ce-1111-2222-3333-444455556666", "conv-2j8rsf", "10.42.0.7"))

	if ip, ok := c.HostIP("5e1949ce-1111-2222-3333-444455556666"); !ok || ip != "10.42.0.7" {
		t.Errorf("UUID lookup = (%q,%v), want (10.42.0.7,true)", ip, ok)
	}
	if ip, ok := c.HostIP("2j8rsf"); !ok || ip != "10.42.0.7" {
		t.Errorf("short-id lookup = (%q,%v), want (10.42.0.7,true)", ip, ok)
	}
}

// A CR whose sandboxRef isn't set yet (created but not provisioned) must not panic and must
// not index a bogus alias — an empty or unprefixed key would shadow unrelated lookups.
func TestHostFromWithoutSandboxRef(t *testing.T) {
	c := NewOwnershipCache()
	c.observe(convCR("uuid-no-ref", "", "10.42.0.8"))

	if ip, ok := c.HostIP("uuid-no-ref"); !ok || ip != "10.42.0.8" {
		t.Errorf("UUID lookup = (%q,%v), want (10.42.0.8,true)", ip, ok)
	}
	if _, ok := c.HostIP(""); ok {
		t.Error("an empty key must never be indexed")
	}
	// A sandboxRef that doesn't carry the `conv-` prefix isn't a short-id; don't invent one.
	c.observe(convCR("uuid-odd-ref", "something-else", "10.42.0.9"))
	if _, ok := c.HostIP("something-else"); ok {
		t.Error("a non conv- prefixed sandboxRef must not be indexed as a short-id")
	}
	if _, ok := c.HostIP("conv-"); ok {
		t.Error("a bare conv- prefix must not be indexed")
	}
}

// Eviction must clear BOTH keys. A stale short-id alias left pointing at a dead pod is worse
// than a miss: a miss falls back to a ready pod, but a stale alias routes to a black hole.
func TestForgetClearsBothKeys(t *testing.T) {
	c := NewOwnershipCache()
	cr := convCR("uuid-gone", "conv-abc123", "10.42.0.7")
	c.observe(cr)
	c.forget(cr)

	if _, ok := c.HostIP("uuid-gone"); ok {
		t.Error("DELETED must clear the UUID key")
	}
	if _, ok := c.HostIP("abc123"); ok {
		t.Error("DELETED must clear the short-id key (a stale alias routes to a dead pod)")
	}
	// The alias must be GONE from the map, not merely dangling: a conversation reusing that
	// UUID later (or the map growing forever) would otherwise resurrect the dead mapping.
	c.mu.RLock()
	_, leaked := c.aliases["abc123"]
	c.mu.RUnlock()
	if leaked {
		t.Error("DELETED left the short-id alias in the map (it must be swept, not just dangling)")
	}
}

// A DELETE event whose payload carries only metadata (no spec.sandboxRef — the watch does not
// always deliver the full object) must STILL sweep the alias. Keying the cleanup off the ref in
// the delete payload alone would leak the alias exactly in that case.
func TestForgetWithoutSpecStillSweepsAlias(t *testing.T) {
	c := NewOwnershipCache()
	c.observe(convCR("uuid-gone", "conv-abc123", "10.42.0.7"))
	c.forget(convCR("uuid-gone", "", "")) // tombstone: name only

	c.mu.RLock()
	_, leaked := c.aliases["abc123"]
	c.mu.RUnlock()
	if leaked {
		t.Error("a spec-less DELETE payload must still sweep the short-id alias")
	}
}

// Unassignment (status.hostIP cleared while the CR lives on) must clear both keys too.
func TestUnassignClearsBothKeys(t *testing.T) {
	c := NewOwnershipCache()
	c.observe(convCR("uuid-x", "conv-zzz999", "10.42.0.7"))
	c.observe(convCR("uuid-x", "conv-zzz999", "")) // controller cleared the owner

	if _, ok := c.HostIP("uuid-x"); ok {
		t.Error("an empty hostIP must unassign the UUID key")
	}
	if _, ok := c.HostIP("zzz999"); ok {
		t.Error("an empty hostIP must unassign the short-id key")
	}
	c.mu.RLock()
	_, leaked := c.aliases["zzz999"]
	c.mu.RUnlock()
	if leaked {
		t.Error("unassignment left the short-id alias in the map")
	}
}

// Hosts() feeds the fleet-aggregate fan-out; the short-id alias points at the SAME pod, so it
// must not make one owner look like two upstreams (which would duplicate every merged row).
func TestHostsDeduplicatesAliases(t *testing.T) {
	c := NewOwnershipCache()
	c.observe(convCR("uuid-a", "conv-aaa111", "10.42.0.7"))
	c.observe(convCR("uuid-b", "conv-bbb222", "10.42.0.8"))

	got := c.Hosts()
	if len(got) != 2 || got[0] != "10.42.0.7" || got[1] != "10.42.0.8" {
		t.Errorf("Hosts() = %v, want [10.42.0.7 10.42.0.8]", got)
	}
}

// End-to-end through the router's own resolution: the broker's short-id-addressed notify
// must reach the OWNER pod, not the ClusterIP fallback (a random ready pod).
func TestResolveTargetByShortID(t *testing.T) {
	cfg := config{namespace: "agent-sandbox", upstreamPort: 8080, clusterIPService: "agent-host"}
	fallback := FallbackURL(cfg.clusterIPService, cfg.namespace, cfg.upstreamPort)
	c := NewOwnershipCache()
	c.observe(convCR("5e1949ce-1111-2222-3333-444455556666", "conv-2j8rsf", "10.42.0.7"))

	// Exactly what the broker's _notify_host POSTs.
	r := httptest.NewRequest("POST", "/conversations/2j8rsf/aws-request", nil)
	if u := resolveTarget(cfg, c, r, fallback); u.String() != "http://10.42.0.7:8080" {
		t.Errorf("short-id aws-request -> %q, want the owner http://10.42.0.7:8080", u.String())
	}
	// The UUID path (UI/webhooks) must still resolve to the same owner.
	r = httptest.NewRequest("GET", "/conversations/5e1949ce-1111-2222-3333-444455556666/events.integrity", nil)
	if u := resolveTarget(cfg, c, r, fallback); u.String() != "http://10.42.0.7:8080" {
		t.Errorf("uuid path -> %q, want the owner http://10.42.0.7:8080", u.String())
	}
}
