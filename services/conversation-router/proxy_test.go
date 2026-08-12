package main

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAguiThreadIDReadsBodyAndRestoresIt(t *testing.T) {
	body := `{"threadId":"conv-xyz","messages":[]}`
	r := httptest.NewRequest("POST", "/agui", strings.NewReader(body))

	id := aguiThreadID(r)
	if id != "conv-xyz" {
		t.Fatalf("threadId = %q, want conv-xyz", id)
	}
	// CRITICAL: the body must still be fully readable by the upstream proxy afterwards.
	rest, _ := io.ReadAll(r.Body)
	if string(rest) != body {
		t.Errorf("body not restored: got %q, want %q", string(rest), body)
	}
}

func TestAguiThreadIDMissing(t *testing.T) {
	r := httptest.NewRequest("POST", "/agui", strings.NewReader(`{"messages":[]}`))
	if id := aguiThreadID(r); id != "" {
		t.Errorf("no threadId should yield empty, got %q", id)
	}
}

func TestResolveTarget(t *testing.T) {
	cfg := config{namespace: "agent-sandbox", upstreamPort: 8080, clusterIPService: "agent-host"}
	fallback := FallbackURL(cfg.clusterIPService, cfg.namespace, cfg.upstreamPort)
	fb := fallback.String() // "http://agent-host.agent-sandbox.svc.cluster.local:8080"
	cache := NewOwnershipCache()
	cache.set("conv-assigned", "10.42.0.2") // owner pod IP

	// non-scoped -> ClusterIP fallback (any ready pod)
	if u := resolveTarget(cfg, cache, httptest.NewRequest("GET", "/healthz", nil), fallback); u.String() != fb {
		t.Errorf("healthz -> %q, want fallback %q", u.String(), fb)
	}
	// path-scoped, assigned -> owner pod IP
	if u := resolveTarget(cfg, cache, httptest.NewRequest("GET", "/conversations/conv-assigned/events.integrity", nil), fallback); u.String() != "http://10.42.0.2:8080" {
		t.Errorf("assigned conv -> %q, want http://10.42.0.2:8080", u.String())
	}
	// path-scoped, UNassigned -> fallback (controller will assign shortly)
	if u := resolveTarget(cfg, cache, httptest.NewRequest("GET", "/conversations/conv-unknown/cancel", nil), fallback); u.String() != fb {
		t.Errorf("unassigned conv -> %q, want fallback %q", u.String(), fb)
	}
	// agui POST, assigned (id in body) -> owner pod IP
	req := httptest.NewRequest("POST", "/agui", strings.NewReader(`{"threadId":"conv-assigned"}`))
	if u := resolveTarget(cfg, cache, req, fallback); u.String() != "http://10.42.0.2:8080" {
		t.Errorf("agui assigned -> %q, want http://10.42.0.2:8080", u.String())
	}
}

func TestOwnershipCache(t *testing.T) {
	c := NewOwnershipCache()
	if _, ok := c.HostIP("x"); ok {
		t.Error("empty cache should miss")
	}
	c.set("x", "10.42.0.1")
	if ip, ok := c.HostIP("x"); !ok || ip != "10.42.0.1" {
		t.Errorf("HostIP(x) = (%q,%v)", ip, ok)
	}
	c.set("x", "") // empty ip = unassigned -> removed
	if _, ok := c.HostIP("x"); ok {
		t.Error("empty ip should be treated as unassigned")
	}
}
