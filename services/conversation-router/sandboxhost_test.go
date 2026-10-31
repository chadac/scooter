package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSandboxLabel(t *testing.T) {
	cases := []struct {
		host, domain, want string
		ok                 bool
	}{
		{"5a515e73.scooter.example.com", "scooter.example.com", "5a515e73", true},
		{"5a515e73.scooter.example.com:443", "scooter.example.com", "5a515e73", true},
		{"5A515E73.Scooter.Example.com.", "scooter.example.com", "5a515e73", true},
		{"5a515e73-860b.scooter.example.com", "scooter.example.com", "5a515e73-860b", true},
		// Disabled, the main host, other domains, nested names.
		{"5a515e73.scooter.example.com", "", "", false},
		{"scooter.example.com", "scooter.example.com", "", false},
		{"5a515e73.other.example.com", "scooter.example.com", "", false},
		{"x.5a515e73.scooter.example.com", "scooter.example.com", "", false},
		// Not a conversation label: too short, non-hex, a hyphen at an edge.
		{"5a515e7.scooter.example.com", "scooter.example.com", "", false},
		{"grafana1.scooter.example.com", "scooter.example.com", "", false},
		{"5a515e73-.scooter.example.com", "scooter.example.com", "", false},
	}
	for _, c := range cases {
		got, ok := SandboxLabel(c.host, c.domain)
		if got != c.want || ok != c.ok {
			t.Errorf("SandboxLabel(%q, %q) = (%q, %v), want (%q, %v)", c.host, c.domain, got, ok, c.want, c.ok)
		}
	}
}

type fakeLabels map[string][]string

func (f fakeLabels) ConversationByLabel(_ context.Context, label string) (string, bool, error) {
	ids := f[label]
	switch len(ids) {
	case 0:
		return "", false, nil
	case 1:
		return ids[0], true, nil
	}
	return "", false, ErrAmbiguousLabel
}

func TestRewriteSandboxRequest(t *testing.T) {
	const id = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff"
	labels := fakeLabels{"5a515e73": {id}, "aaaaaaaa": {"aaaaaaaa-1", "aaaaaaaa-2"}}

	r := httptest.NewRequest("GET", "http://5a515e73.scooter.example.com/marimo/assets/x.js?v=1", nil)
	w := httptest.NewRecorder()
	if !rewriteSandboxRequest(w, r, "5a515e73", labels) {
		t.Fatalf("rewrite refused: %d %s", w.Code, w.Body)
	}
	if want := "/c/" + id + "/marimo/assets/x.js"; r.URL.Path != want {
		t.Errorf("path = %q, want %q", r.URL.Path, want)
	}
	if r.URL.RawQuery != "v=1" {
		t.Errorf("query = %q, want v=1", r.URL.RawQuery)
	}
	if r.Header.Get(SandboxHostHeader) != "5a515e73" {
		t.Errorf("missing %s", SandboxHostHeader)
	}
	if id, ok := ConvIDFromPath(r.URL.Path); !ok || id != "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff" {
		t.Errorf("rewritten path does not route: %q %v", id, ok)
	}

	for _, c := range []struct {
		name, label, path string
		code              int
		store             labelResolver
	}{
		{"root has no service", "5a515e73", "/", http.StatusNotFound, labels},
		{"unknown label", "bbbbbbbb", "/marimo/", http.StatusNotFound, labels},
		{"ambiguous label", "aaaaaaaa", "/marimo/", http.StatusConflict, labels},
		{"no store", "5a515e73", "/marimo/", http.StatusServiceUnavailable, nil},
	} {
		r := httptest.NewRequest("GET", "http://x"+c.path, nil)
		w := httptest.NewRecorder()
		if rewriteSandboxRequest(w, r, c.label, c.store) {
			t.Errorf("%s: rewrite accepted", c.name)
		} else if w.Code != c.code {
			t.Errorf("%s: code = %d, want %d", c.name, w.Code, c.code)
		}
	}
}

// The main listener refuses every sandbox-domain host, so the API is never reachable
// through one, and a client cannot forge the routing header.
func TestMainListenerRefusesSandboxHosts(t *testing.T) {
	var seen *http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()
	cfg := config{sandboxDomain: "scooter.example.com", fallback: mustURL(t, upstream.URL)}
	h := newRouter(context.Background(), cfg, nil, nil, nil, nil, nil, nil, nil)

	for _, host := range []string{"5a515e73.scooter.example.com", "foo.scooter.example.com", "a.b.scooter.example.com"} {
		r := httptest.NewRequest("GET", "http://"+host+"/conversations", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusNotFound || seen != nil {
			t.Fatalf("%s reached the main listener: code=%d proxied=%v", host, w.Code, seen != nil)
		}
	}

	// The main host proxies as before, with a forged header removed.
	r := httptest.NewRequest("GET", "http://scooter.example.com/c/abc/marimo/", nil)
	r.Header.Set(SandboxHostHeader, "5a515e73")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if seen == nil {
		t.Fatalf("main host not proxied: %d", w.Code)
	}
	if v := seen.Header.Get(SandboxHostHeader); v != "" {
		t.Errorf("forged %s reached the upstream: %q", SandboxHostHeader, v)
	}
}

// The sandbox listener serves a valid sandbox host's services and 404s everything else,
// including every router endpoint and any other host.
func TestSandboxListenerServesOnlyServices(t *testing.T) {
	const id = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff"
	var seen *http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()
	cfg := config{sandboxDomain: "scooter.example.com", fallback: mustURL(t, upstream.URL)}
	h := newSandboxHandler(context.Background(), cfg, nil, fakeLabels{"5a515e73": {id}}, cfg.fallback, nil)

	for _, c := range []struct{ host, path string }{
		{"scooter.example.com", "/conversations"},        // the main host
		{"scooter.example.com", "/c/" + id + "/marimo/"}, // even a service path
		{"foo.scooter.example.com", "/conversations"},    // not a label
		{"evil.example.com", "/healthz"},                 // another domain
		{"5a515e73.scooter.example.com", "/"},            // no service segment
	} {
		seen = nil
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "http://"+c.host+c.path, nil))
		if w.Code != http.StatusNotFound || seen != nil {
			t.Errorf("%s%s: code=%d proxied=%v, want a 404 and nothing proxied", c.host, c.path, w.Code, seen != nil)
		}
	}

	seen = nil
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://5a515e73.scooter.example.com/marimo/x", nil))
	if seen == nil {
		t.Fatalf("a sandbox host's service was not proxied: %d", w.Code)
	}
	if seen.URL.Path != "/c/"+id+"/marimo/x" || seen.Header.Get(SandboxHostHeader) != "5a515e73" {
		t.Errorf("proxied %q with header %q", seen.URL.Path, seen.Header.Get(SandboxHostHeader))
	}
}

func TestSandboxListenerRefusesCrossOriginWebSockets(t *testing.T) {
	const id = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff"
	var proxied bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxied = true
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()
	cfg := config{sandboxDomain: "scooter.example.com", fallback: mustURL(t, upstream.URL)}
	h := newSandboxHandler(context.Background(), cfg, nil, fakeLabels{"5a515e73": {id}}, cfg.fallback, nil)

	for _, c := range []struct {
		name, upgrade, origin string
		refused               bool
	}{
		{"same origin", "websocket", "https://5a515e73.scooter.example.com", false},
		{"same origin, any case", "WebSocket", "https://5A515E73.scooter.example.com", false},
		{"no Origin", "websocket", "", false},
		{"plain request from another origin", "", "https://feedbeef.scooter.example.com", false},
		{"another sandbox", "websocket", "https://feedbeef.scooter.example.com", true},
		{"the main host", "websocket", "https://scooter.example.com", true},
		{"another site", "websocket", "https://evil.example.net", true},
		{"opaque origin", "websocket", "null", true},
	} {
		proxied = false
		req := httptest.NewRequest("GET", "http://5a515e73.scooter.example.com/terminal/ws", nil)
		if c.upgrade != "" {
			req.Header.Set("Connection", "Upgrade")
			req.Header.Set("Upgrade", c.upgrade)
		}
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if refused := w.Code == http.StatusForbidden && !proxied; refused != c.refused {
			t.Errorf("%s: code=%d proxied=%v, want refused=%v", c.name, w.Code, proxied, c.refused)
		}
	}
}
