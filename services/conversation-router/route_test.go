package main

import "testing"

func TestConvIDFromPath(t *testing.T) {
	cases := []struct {
		path   string
		want   string
		wantOK bool
	}{
		{"/conversations/abc123", "abc123", true},
		{"/conversations/abc123/events.integrity", "abc123", true},
		{"/conversations/abc123/cancel", "abc123", true},
		{"/conversations/abc123/links", "abc123", true},
		{"/c/xyz789/marimo/", "xyz789", true},           // web-service proxy (HTTP or WS)
		{"/c/xyz789/ttyd/socket", "xyz789", true},
		{"/conversations", "", false},                    // no id
		{"/healthz", "", false},                          // non-scoped
		{"/agui", "", false},                             // id is in the body, not path
		{"/", "", false},
	}
	for _, c := range cases {
		got, ok := ConvIDFromPath(c.path)
		if got != c.want || ok != c.wantOK {
			t.Errorf("ConvIDFromPath(%q) = (%q,%v), want (%q,%v)", c.path, got, ok, c.want, c.wantOK)
		}
	}
}

func TestIsAguiPost(t *testing.T) {
	if !IsAguiPost("POST", "/agui") {
		t.Error("POST /agui should be an agui post")
	}
	if IsAguiPost("GET", "/agui") {
		t.Error("GET /agui is not an agui post")
	}
	if IsAguiPost("POST", "/conversations/x") {
		t.Error("POST /conversations/x is not an agui post")
	}
}

func TestIsNonScoped(t *testing.T) {
	for _, p := range []string{"/healthz", "/health", "/metrics", "/"} {
		if !IsNonScoped(p) {
			t.Errorf("%q should be non-scoped", p)
		}
	}
	for _, p := range []string{"/conversations/x", "/c/x/marimo/", "/agui"} {
		if IsNonScoped(p) {
			t.Errorf("%q should be conversation-scoped", p)
		}
	}
}

func TestTargetURL(t *testing.T) {
	u := TargetURL("agent-host-0", "agent-host-headless", "agent-sandbox", 8080)
	want := "http://agent-host-0.agent-host-headless.agent-sandbox.svc.cluster.local:8080"
	if u.String() != want {
		t.Errorf("TargetURL = %q, want %q", u.String(), want)
	}
}
