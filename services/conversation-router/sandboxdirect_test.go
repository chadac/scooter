package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const directID = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff"

// fakeAgentHost answers the target and touch routes and records everything else it serves.
type fakeAgentHost struct {
	srv     *httptest.Server
	lookups atomic.Int32
	touches atomic.Int32
	mu      sync.Mutex
	served  []*http.Request
	// answer builds the target reply; status != 200 sends the request to the agent-host.
	answer func(r *http.Request) (int, directTarget)
}

func newFakeAgentHost(t *testing.T, answer func(r *http.Request) (int, directTarget)) *fakeAgentHost {
	f := &fakeAgentHost{answer: answer}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case internalPrefix + "/target":
			f.lookups.Add(1)
			status, body := f.answer(r)
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(body)
		case internalPrefix + "/touch":
			f.touches.Add(1)
			w.WriteHeader(http.StatusAccepted)
		default:
			f.mu.Lock()
			f.served = append(f.served, r.Clone(context.Background()))
			f.mu.Unlock()
			w.Header().Set("X-Served-By", "agent-host")
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "agent-host "+r.URL.RequestURI())
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAgentHost) servedPaths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.served {
		out = append(out, r.URL.RequestURI())
	}
	return out
}

// fakePod echoes what reached it.
func fakePod(t *testing.T) (*httptest.Server, *[]*http.Request, *sync.Mutex) {
	var mu sync.Mutex
	var seen []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Clone(context.Background()))
		mu.Unlock()
		if r.Header.Get("Upgrade") == "websocket" {
			hj, _ := w.(http.Hijacker)
			conn, buf, _ := hj.Hijack()
			_, _ = buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: _oauth2_proxy=evil\r\nSet-Cookie: app=1\r\n\r\n")
			_ = buf.Flush()
			go func() {
				defer conn.Close()
				b := make([]byte, 64)
				for {
					n, err := buf.Read(b)
					if err != nil {
						return
					}
					_, _ = conn.Write(b[:n])
				}
			}()
			return
		}
		w.Header().Add("Set-Cookie", "_oauth2_proxy=evil; Domain=.example.com")
		w.Header().Add("Set-Cookie", "AWSELBAuthSessionCookie-0=x")
		w.Header().Add("Set-Cookie", "app=1; Path=/")
		w.Header().Set("X-Pod-Path", r.URL.RequestURI())
		_, _ = io.WriteString(w, "pod "+r.Method)
	}))
	t.Cleanup(srv.Close)
	return srv, &seen, &mu
}

func podTargetFor(t *testing.T, pod *httptest.Server) directTarget {
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(pod.URL, "http://"))
	return directTarget{
		ConversationID: directID,
		PodIP:          host,
		Port:           atoi(port),
		DropHeaders:    []string{"x-auth-user", "x-auth-email", "x-amzn-oidc-accesstoken", "x-scooter-user", "x-scooter-user-email"},
		SessionCookies: []string{"_oauth2_proxy", "AWSELBAuthSessionCookie"},
		TTLMs:          15000,
	}
}

func directHandler(t *testing.T, ah *fakeAgentHost, d *directProxy) http.Handler {
	cfg := config{sandboxDomain: "scooter.example.com", fallback: mustURL(t, ah.srv.URL)}
	return newSandboxHandler(context.Background(), cfg, nil, fakeLabels{"5a515e73": {directID}}, cfg.fallback, d)
}

func sandboxGet(t *testing.T, h http.Handler, method, path string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "http://5a515e73.scooter.example.com"+path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestDirectProxiesToThePod(t *testing.T) {
	pod, seen, mu := fakePod(t)
	ah := newFakeAgentHost(t, func(r *http.Request) (int, directTarget) {
		tg := podTargetFor(t, pod)
		if r.Header.Get("x-auth-user") == "alice" {
			tg.User = &struct {
				ID    string `json:"id"`
				Email string `json:"email,omitempty"`
			}{ID: "alice", Email: "a@x"}
		}
		if q := r.URL.Query(); q.Get("conversation") != directID || q.Get("service") != "marimo" || q.Get("label") != "5a515e73" {
			t.Errorf("target query = %v", q)
		}
		return 200, tg
	})
	h := directHandler(t, ah, newDirectProxy())
	hdr := map[string]string{
		"x-auth-user":             "alice",
		"x-auth-email":            "a@x",
		"x-amzn-oidc-accesstoken": "tok",
		"x-scooter-user":          "mallory",
		SandboxHostHeader:         "forged",
		"Cookie":                  "_oauth2_proxy=secret; app=1; _oauth2_proxy_csrf=x",
	}
	rec := sandboxGet(t, h, "GET", "/marimo/app%2Fx?x=1", hdr)
	if rec.Code != 200 || rec.Body.String() != "pod GET" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get(DirectRouteHeader); got != "direct" {
		t.Errorf("%s = %q, want direct", DirectRouteHeader, got)
	}
	if got := rec.Header().Get("X-Pod-Path"); got != "/marimo/app%2Fx?x=1" {
		t.Errorf("pod path = %q, want the browser path", got)
	}
	if got := rec.Header().Values("Set-Cookie"); len(got) != 1 || got[0] != "app=1; Path=/" {
		t.Errorf("Set-Cookie = %q, want only the pod's own cookie", got)
	}
	mu.Lock()
	r := (*seen)[0]
	mu.Unlock()
	for name, want := range map[string]string{
		"X-Scooter-User":          "alice",
		"X-Scooter-User-Email":    "a@x",
		"X-Auth-User":             "",
		"X-Auth-Email":            "",
		"X-Amzn-Oidc-Accesstoken": "",
		SandboxHostHeader:         "",
		"Cookie":                  "app=1",
	} {
		if got := r.Header.Get(name); got != want {
			t.Errorf("pod saw %s = %q, want %q", name, got, want)
		}
	}
	if !strings.HasPrefix(r.Host, "127.0.0.1:") {
		t.Errorf("pod Host = %q, want the pod address", r.Host)
	}

	// A second request reuses the cached answer.
	sandboxGet(t, h, "GET", "/marimo/other", hdr)
	if n := ah.lookups.Load(); n != 1 {
		t.Errorf("lookups = %d, want 1 (cached)", n)
	}
	// A different caller never shares an entry.
	sandboxGet(t, h, "GET", "/marimo/other", map[string]string{"x-auth-user": "bob"})
	if n := ah.lookups.Load(); n != 2 {
		t.Errorf("lookups = %d, want 2 (per caller)", n)
	}
	mu.Lock()
	bob := (*seen)[2]
	mu.Unlock()
	if got := bob.Header.Get("X-Scooter-User"); got != "" {
		t.Errorf("bob's request carried X-Scooter-User %q", got)
	}
	if paths := ah.servedPaths(); len(paths) != 0 {
		t.Errorf("agent-host served %v, want nothing", paths)
	}
}

func TestDirectStripBasePath(t *testing.T) {
	pod, _, _ := fakePod(t)
	ah := newFakeAgentHost(t, func(*http.Request) (int, directTarget) {
		tg := podTargetFor(t, pod)
		tg.StripBasePath = true
		return 200, tg
	})
	h := directHandler(t, ah, newDirectProxy())
	if got := sandboxGet(t, h, "GET", "/code/app?x=1", nil).Header().Get("X-Pod-Path"); got != "/app?x=1" {
		t.Errorf("pod path = %q", got)
	}
	if got := sandboxGet(t, h, "GET", "/code", nil).Header().Get("X-Pod-Path"); got != "/" {
		t.Errorf("pod path = %q", got)
	}
}

// Asleep, unknown, or the loading page's poll: the agent-host serves it, as before.
func TestDirectFallsBackToTheAgentHost(t *testing.T) {
	ah := newFakeAgentHost(t, func(*http.Request) (int, directTarget) { return 503, directTarget{} })
	h := directHandler(t, ah, newDirectProxy())
	rec := sandboxGet(t, h, "GET", "/marimo/app", nil)
	if rec.Header().Get("X-Served-By") != "agent-host" {
		t.Fatalf("not served by the agent-host: %d %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get(DirectRouteHeader); got != "" {
		t.Errorf("%s = %q on an agent-host response", DirectRouteHeader, got)
	}
	sandboxGet(t, h, "GET", "/marimo/"+statusSegment, nil)
	if n := ah.lookups.Load(); n != 1 {
		t.Errorf("lookups = %d, want 1 (the status poll never looks up)", n)
	}
	want := []string{"/c/" + directID + "/marimo/app", "/c/" + directID + "/marimo/" + statusSegment}
	if got := ah.servedPaths(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("agent-host served %v, want %v", got, want)
	}
	ah.mu.Lock()
	defer ah.mu.Unlock()
	if got := ah.served[0].Header.Get(SandboxHostHeader); got != "5a515e73" {
		t.Errorf("routing header = %q", got)
	}
}

// The ACP socket is agent-host's own, even while the pod would take requests direct.
func TestDirectLeavesThePlatformPathToTheAgentHost(t *testing.T) {
	ah := newFakeAgentHost(t, func(*http.Request) (int, directTarget) { return 200, directTarget{} })
	h := directHandler(t, ah, newDirectProxy())
	rec := sandboxGet(t, h, "GET", "/_scooter/acp", nil)
	if rec.Header().Get("X-Served-By") != "agent-host" {
		t.Fatalf("not served by the agent-host: %d %q", rec.Code, rec.Body.String())
	}
	if n := ah.lookups.Load(); n != 0 {
		t.Errorf("lookups = %d, want 0", n)
	}
	if got := ah.servedPaths(); strings.Join(got, ",") != "/c/"+directID+"/_scooter/acp" {
		t.Errorf("agent-host served %v", got)
	}
}

// A pod that refuses: a GET goes to the agent-host (which starts the unit and shows the
// loading page) and the cached answer is dropped; a request with a body gets a 502.
func TestDirectPodRefused(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	tg := podTargetFor(t, dead)
	dead.Close()
	ah := newFakeAgentHost(t, func(*http.Request) (int, directTarget) { return 200, tg })
	h := directHandler(t, ah, newDirectProxy())
	rec := sandboxGet(t, h, "GET", "/marimo/", map[string]string{"Accept": "text/html"})
	if rec.Header().Get("X-Served-By") != "agent-host" {
		t.Fatalf("refused GET not sent to the agent-host: %d %q", rec.Code, rec.Body.String())
	}
	sandboxGet(t, h, "GET", "/marimo/", nil)
	if n := ah.lookups.Load(); n != 2 {
		t.Errorf("lookups = %d, want 2 (a refusal drops the cache)", n)
	}
	if rec := sandboxGet(t, h, "POST", "/marimo/api", nil); rec.Code != http.StatusBadGateway {
		t.Errorf("refused POST = %d, want 502", rec.Code)
	}
}

func TestDirectTouchIsThrottled(t *testing.T) {
	pod, _, _ := fakePod(t)
	ah := newFakeAgentHost(t, func(*http.Request) (int, directTarget) {
		tg := podTargetFor(t, pod)
		tg.TTLMs = 60000
		return 200, tg
	})
	d := newDirectProxy()
	var now atomic.Int64
	now.Store(time.Now().UnixNano())
	d.now = func() time.Time { return time.Unix(0, now.Load()) }
	h := directHandler(t, ah, d)
	for i := 0; i < 5; i++ {
		sandboxGet(t, h, "GET", "/marimo/", nil)
	}
	// The lookup itself counts on the agent-host, so nothing more within the window.
	time.Sleep(50 * time.Millisecond)
	if n := ah.touches.Load(); n != 0 {
		t.Errorf("touches = %d, want 0 inside the window", n)
	}
	now.Add(int64(directTouchInterval + time.Second))
	sandboxGet(t, h, "GET", "/marimo/", nil)
	sandboxGet(t, h, "GET", "/marimo/", nil)
	waitFor(t, func() bool { return ah.touches.Load() == 1 })
	if n := ah.lookups.Load(); n != 1 {
		t.Errorf("lookups = %d, want 1", n)
	}
}

func TestDirectWebSocket(t *testing.T) {
	pod, seen, mu := fakePod(t)
	ah := newFakeAgentHost(t, func(*http.Request) (int, directTarget) { return 200, podTargetFor(t, pod) })
	d := newDirectProxy()
	front := httptest.NewServer(directHandler(t, ah, d))
	defer front.Close()

	conn, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "GET /marimo/ws HTTP/1.1\r\nHost: 5a515e73.scooter.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: _oauth2_proxy=secret\r\n\r\n")
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if got := res.Header.Values("Set-Cookie"); len(got) != 1 || got[0] != "app=1" {
		t.Errorf("handshake Set-Cookie = %q", got)
	}
	_, _ = io.WriteString(conn, "ping")
	b := make([]byte, 4)
	if _, err := io.ReadFull(br, b); err != nil || string(b) != "ping" {
		t.Fatalf("echo = %q, %v", b, err)
	}
	mu.Lock()
	r := (*seen)[0]
	mu.Unlock()
	if r.URL.Path != "/marimo/ws" || r.Header.Get("Cookie") != "" {
		t.Errorf("pod saw %s with Cookie %q", r.URL.Path, r.Header.Get("Cookie"))
	}
	// code-server's WebSocket origin check compares Origin with the forwarded host.
	if got := r.Header.Get("X-Forwarded-Host"); got != "5a515e73.scooter.example.com" {
		t.Errorf("pod saw X-Forwarded-Host %q, want the sandbox host", got)
	}
}

func TestDirectForwardsTheSandboxHost(t *testing.T) {
	pod, seen, mu := fakePod(t)
	ah := newFakeAgentHost(t, func(*http.Request) (int, directTarget) { return 200, podTargetFor(t, pod) })
	rec := sandboxGet(t, directHandler(t, ah, newDirectProxy()), "GET", "/vscode/", map[string]string{"X-Forwarded-Host": "evil.example.org"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	mu.Lock()
	r := (*seen)[0]
	mu.Unlock()
	if got := r.Header.Values("X-Forwarded-Host"); len(got) != 1 || got[0] != "5a515e73.scooter.example.com" {
		t.Errorf("pod saw X-Forwarded-Host %q, want only the sandbox host", got)
	}
}

func TestDirectDisabled(t *testing.T) {
	ah := newFakeAgentHost(t, func(*http.Request) (int, directTarget) { return 200, directTarget{} })
	rec := sandboxGet(t, directHandler(t, ah, nil), "GET", "/marimo/", nil)
	if rec.Header().Get("X-Served-By") != "agent-host" || ah.lookups.Load() != 0 {
		t.Errorf("SANDBOX_DIRECT=0 still looked up (%d) or did not use the agent-host", ah.lookups.Load())
	}
}

func TestSandboxService(t *testing.T) {
	for _, c := range []struct {
		in, svc, rest string
		ok            bool
	}{
		{"/marimo/app/x", "marimo", "/app/x", true},
		{"/marimo", "marimo", "/", true},
		{"/marimo/", "marimo", "/", true},
		{"/a%20b/x%2Fy", "a b", "/x%2Fy", true},
		{"/", "", "", false},
	} {
		svc, rest, ok := sandboxService(c.in)
		if svc != c.svc || rest != c.rest || ok != c.ok {
			t.Errorf("sandboxService(%q) = %q %q %v", c.in, svc, rest, ok)
		}
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDirectInvalidatedByARowChange(t *testing.T) {
	pod, _, _ := fakePod(t)
	tg := podTargetFor(t, pod)
	var asleep atomic.Bool
	ah := newFakeAgentHost(t, func(*http.Request) (int, directTarget) {
		if asleep.Load() {
			return http.StatusServiceUnavailable, directTarget{}
		}
		return 200, tg
	})
	d := newDirectProxy()
	h := directHandler(t, ah, d)
	if rec := sandboxGet(t, h, "GET", "/files/", nil); rec.Header().Get(DirectRouteHeader) != "direct" {
		t.Fatalf("awake request not carried direct: %d %q", rec.Code, rec.Body.String())
	}

	asleep.Store(true)
	d.invalidate(directID)
	rec := sandboxGet(t, h, "GET", "/files/", nil)
	if rec.Header().Get("X-Served-By") != "agent-host" {
		t.Fatalf("after the row change the cached pod still served: %d %q", rec.Code, rec.Body.String())
	}
	if n := ah.lookups.Load(); n != 2 {
		t.Errorf("lookups = %d, want 2 (the row change drops the cache)", n)
	}
}

func TestMovesPod(t *testing.T) {
	for payload, want := range map[string]bool{
		`{"id":"a","op":"upsert","kind":"meta"}`:     true,
		`{"id":"a","op":"delete","kind":"meta"}`:     true,
		`{"id":"a","op":"upsert"}`:                   true, // pre-#776: un-throttled, so treated as meta
		`{"id":"a","op":"upsert","kind":"activity"}`: false,
	} {
		c, ok := notifyDecision(payload)
		if !ok || c.movesPod() != want {
			t.Errorf("%s: movesPod = %v, want %v", payload, c.movesPod(), want)
		}
	}
}

func TestDirectInvalidatedMidLookup(t *testing.T) {
	pod, _, _ := fakePod(t)
	tg := podTargetFor(t, pod)
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	var first atomic.Bool
	first.Store(true)
	ah := newFakeAgentHost(t, func(*http.Request) (int, directTarget) {
		if first.CompareAndSwap(true, false) {
			entered <- struct{}{}
			<-release
		}
		return 200, tg
	})
	d := newDirectProxy()
	h := directHandler(t, ah, d)
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- sandboxGet(t, h, "GET", "/files/", nil) }()
	<-entered
	d.invalidate(directID)
	close(release)
	if rec := <-done; rec.Header().Get("X-Served-By") != "agent-host" {
		t.Fatalf("a lookup invalidated mid-flight still went direct: %q", rec.Header().Get(DirectRouteHeader))
	}
	if rec := sandboxGet(t, h, "GET", "/files/", nil); rec.Header().Get(DirectRouteHeader) != "direct" {
		t.Fatalf("settled lookup not direct: %d", rec.Code)
	}
	if n := ah.lookups.Load(); n != 2 {
		t.Errorf("lookups = %d, want 2", n)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.gen) != 0 {
		t.Errorf("gen left behind: %v", d.gen)
	}
}

func TestDirectInvalidateNil(t *testing.T) {
	var d *directProxy
	d.invalidate(directID)
}
