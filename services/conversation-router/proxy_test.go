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

func TestResolveHost(t *testing.T) {
	cfg := config{defaultPod: "agent-host-0"}
	cache := NewOwnershipCache()
	cache.set("conv-assigned", "agent-host-2")

	// non-scoped -> default pod
	if h := resolveHost(cfg, cache, httptest.NewRequest("GET", "/healthz", nil)); h != "agent-host-0" {
		t.Errorf("healthz -> %q, want default agent-host-0", h)
	}
	// path-scoped, assigned -> owner
	if h := resolveHost(cfg, cache, httptest.NewRequest("GET", "/conversations/conv-assigned/events.integrity", nil)); h != "agent-host-2" {
		t.Errorf("assigned conv -> %q, want agent-host-2", h)
	}
	// path-scoped, UNassigned -> default pod (controller will assign shortly)
	if h := resolveHost(cfg, cache, httptest.NewRequest("GET", "/conversations/conv-unknown/cancel", nil)); h != "agent-host-0" {
		t.Errorf("unassigned conv -> %q, want default agent-host-0", h)
	}
	// agui POST, assigned (id in body) -> owner
	req := httptest.NewRequest("POST", "/agui", strings.NewReader(`{"threadId":"conv-assigned"}`))
	if h := resolveHost(cfg, cache, req); h != "agent-host-2" {
		t.Errorf("agui assigned -> %q, want agent-host-2", h)
	}
}

func TestOwnershipCache(t *testing.T) {
	c := NewOwnershipCache()
	if _, ok := c.Host("x"); ok {
		t.Error("empty cache should miss")
	}
	c.set("x", "agent-host-1")
	if h, ok := c.Host("x"); !ok || h != "agent-host-1" {
		t.Errorf("Host(x) = (%q,%v)", h, ok)
	}
	c.set("x", "") // empty host = unassigned -> removed
	if _, ok := c.Host("x"); ok {
		t.Error("empty host should be treated as unassigned")
	}
}
