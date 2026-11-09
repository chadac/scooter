package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRewriterMapsDevURLsToThePublicOrigin(t *testing.T) {
	rw := newRewriter(5173)
	pub := &url.URL{Scheme: "https", Host: "abc.sbx.example.com"}
	in := `fetch("http://localhost:5173/review-app/api"); new WebSocket("ws://127.0.0.1:5173/review-app/");` +
		` "http://0.0.0.0:5173/x" "http://localhost:51730/keep" "http://localhost:8080/keep"`
	got := rw.String(in, pub)
	for _, want := range []string{
		`fetch("https://abc.sbx.example.com/review-app/api")`,
		`new WebSocket("wss://abc.sbx.example.com/review-app/")`,
		`"https://abc.sbx.example.com/x"`,
		`"http://localhost:51730/keep"`,
		`"http://localhost:8080/keep"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in\n%s", want, got)
		}
	}
	if !rw.IsLocal("http://localhost:5173") || rw.IsLocal("http://localhost:5173.evil.com") {
		t.Error("IsLocal")
	}
}

func TestRelaxCSP(t *testing.T) {
	cases := map[string]string{
		"default-src 'self'; frame-ancestors 'none'":     "default-src 'self' data: blob:",
		"script-src 'none'; img-src https://cdn.x":       "script-src 'self'; img-src https://cdn.x 'self' data: blob:",
		"script-src 'nonce-a' 'strict-dynamic'":          "script-src 'nonce-a' 'strict-dynamic'",
		"style-src 'self'; connect-src https://api.x.io": "style-src 'self'; connect-src https://api.x.io 'self'",
	}
	for in, want := range cases {
		if got := relaxCSP(in); got != want {
			t.Errorf("relaxCSP(%q) = %q, want %q", in, got, want)
		}
	}
	html := `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; frame-ancestors 'none'">` +
		`<meta content='img-src x' http-equiv='content-security-policy'>`
	got := string(relaxMetaCSP([]byte(html)))
	if !strings.Contains(got, `content="default-src 'self' data: blob:"`) || !strings.Contains(got, `content='img-src x 'self' data: blob:'`) {
		t.Errorf("relaxMetaCSP: %s", got)
	}
}

func TestInjectGoesFirstInHead(t *testing.T) {
	tag := "<script x></script>"
	for in, want := range map[string]string{
		"<!doctype html><html><head><title>t</title></head>": "<!doctype html><html><head><script x></script><title>t</title></head>",
		"<!DOCTYPE html><HTML lang=en><body>b":               "<!DOCTYPE html><HTML lang=en><script x></script><body>b",
		"<!doctype html><p>bare":                             "<!doctype html><script x></script><p>bare",
		"fragment":                                           "<script x></script>fragment",
	} {
		if got := string(inject([]byte(in), tag)); got != want {
			t.Errorf("inject(%q) = %q, want %q", in, got, want)
		}
	}
}

// fixture: the review-app proxy before a fake dev server.
type fixture struct {
	site  Site
	app   *App
	front *httptest.Server
	dev   *httptest.Server
	woke  chan string
}

func newFixture(t *testing.T, dev http.Handler) *fixture {
	t.Helper()
	dir := t.TempDir()
	f := &fixture{woke: make(chan string, 8)}
	conv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("authorization") != "Bearer tok" || body["source"] != "web-review" {
			t.Errorf("wake: auth %q source %q", r.Header.Get("authorization"), body["source"])
		}
		f.woke <- body["text"]
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(conv.Close)
	token := filepath.Join(dir, "token")
	_ = os.WriteFile(token, []byte("tok\n"), 0o600)
	f.dev = httptest.NewServer(dev)
	t.Cleanup(f.dev.Close)
	f.site = Site{
		Prefix: "/c/conv1", StateDir: filepath.Join(dir, "state"), ConvID: "conv1",
		SelfURL: conv.URL, TokenPath: token, Public: &url.URL{Scheme: "https", Host: "conv1.sbx.example.com"},
	}
	store, err := openStore(f.site.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	f.app = newApp(f.site, store)
	f.app.runCmd = func(string, ...string) ([]byte, error) { return nil, nil }
	f.front = httptest.NewServer(f.app)
	t.Cleanup(f.front.Close)
	return f
}

func (f *fixture) target(t *testing.T) {
	port, _ := strconv.Atoi(strings.TrimPrefix(f.dev.URL, "http://127.0.0.1:"))
	if err := writeTarget(f.site, Target{Port: port, Cwd: "/workspace/app"}); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) get(t *testing.T, path string, hdr map[string]string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", f.front.URL+path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func TestProxyRewritesTheAppForTheFrame(t *testing.T) {
	var seen *http.Request
	f := newFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r
		port := strings.TrimPrefix(r.Host, "localhost:")
		switch r.URL.Path {
		case "/c/conv1/review-app/login":
			w.Header().Set("Location", "http://localhost:"+port+"/c/conv1/review-app/")
			w.Header().Add("Set-Cookie", "sid=1; Domain=localhost; Path=/")
			w.WriteHeader(http.StatusFound)
		case "/c/conv1/review-app/app.js":
			w.Header().Set("Content-Type", "text/javascript")
			io.WriteString(w, `new WebSocket("ws://localhost:`+port+`/hmr")`)
		default:
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
			io.WriteString(w, `<!doctype html><html><head><title>App</title></head><body><a href="http://localhost:`+port+`/c/conv1/review-app/x">x</a></body></html>`)
		}
	}))

	res, body := f.get(t, "/c/conv1/review-app/", map[string]string{"Sec-Fetch-Dest": "document"})
	if !strings.Contains(body, "No app to review yet") {
		t.Fatalf("no target: %d %s", res.StatusCode, body)
	}
	f.target(t)

	res, body = f.get(t, "/c/conv1/review-app/orders/42", map[string]string{
		"Sec-Fetch-Dest": "iframe", "X-Forwarded-Host": "conv1.sbx.example.com", "X-Forwarded-Proto": "https",
		"Origin": "https://conv1.sbx.example.com", "Accept-Encoding": "gzip",
	})
	if seen.URL.Path != "/c/conv1/review-app/orders/42" {
		t.Errorf("path not forwarded as is: %s", seen.URL.Path)
	}
	if !strings.HasPrefix(seen.Host, "localhost:") || seen.Header.Get("Accept-Encoding") != "identity" ||
		seen.Header.Get("X-Forwarded-Prefix") != "/c/conv1/review-app" || !strings.HasPrefix(seen.Header.Get("Origin"), "http://localhost:") {
		t.Errorf("upstream request: host %q headers %v", seen.Host, seen.Header)
	}
	if res.Header.Get("X-Frame-Options") != "" || strings.Contains(res.Header.Get("Content-Security-Policy"), "frame-ancestors") {
		t.Errorf("framing headers kept: %v", res.Header)
	}
	if !strings.Contains(body, `<head><script src="/c/conv1/review-app/__review/overlay.js" data-app-base="/c/conv1/review-app" data-shell-base="/c/conv1/review"></script><title>`) {
		t.Errorf("overlay not injected: %s", body)
	}
	if !strings.Contains(body, `href="https://conv1.sbx.example.com/c/conv1/review-app/x"`) {
		t.Errorf("localhost link not rewritten: %s", body)
	}
	if res.ContentLength != int64(len(body)) {
		t.Errorf("content-length %d for %d bytes", res.ContentLength, len(body))
	}

	_, js := f.get(t, "/c/conv1/review-app/app.js", map[string]string{"Sec-Fetch-Dest": "script", "X-Forwarded-Host": "conv1.sbx.example.com"})
	if js != `new WebSocket("wss://conv1.sbx.example.com/hmr")` {
		t.Errorf("js: %s", js)
	}

	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, _ := http.NewRequest("GET", f.front.URL+"/c/conv1/review-app/login", nil)
	req.Header.Set("X-Forwarded-Host", "conv1.sbx.example.com")
	res, err := noRedirect.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if loc := res.Header.Get("Location"); loc != "https://conv1.sbx.example.com/c/conv1/review-app/" {
		t.Errorf("Location: %s", loc)
	}
	if c := res.Header.Get("Set-Cookie"); strings.Contains(strings.ToLower(c), "domain") {
		t.Errorf("Set-Cookie kept its localhost domain: %s", c)
	}
}

func TestProxyPassesWebSocketsThrough(t *testing.T) {
	f := newFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "websocket" {
			http.Error(w, "want upgrade", 400)
			return
		}
		conn, rw, _ := w.(http.Hijacker).Hijack()
		defer conn.Close()
		rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		rw.Flush()
		line, _ := rw.ReadString('\n')
		rw.WriteString("echo " + line)
		rw.Flush()
	}))
	f.target(t)
	conn, err := net.Dial("tcp", strings.TrimPrefix(f.front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	io.WriteString(conn, "GET /c/conv1/review-app/hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
	br := bufio.NewReader(conn)
	status, _ := br.ReadString('\n')
	if !strings.Contains(status, "101") {
		t.Fatalf("status %q", status)
	}
	for {
		l, _ := br.ReadString('\n')
		if l == "\r\n" || l == "" {
			break
		}
	}
	io.WriteString(conn, "ping\n")
	if got, _ := br.ReadString('\n'); got != "echo ping\n" {
		t.Errorf("got %q", got)
	}
}

func TestProxyExplainsADeadDevServer(t *testing.T) {
	f := newFixture(t, http.NotFoundHandler())
	f.dev.Close()
	f.target(t)
	res, body := f.get(t, "/c/conv1/review-app/", map[string]string{"Sec-Fetch-Dest": "iframe"})
	if res.StatusCode != http.StatusBadGateway || !strings.Contains(body, "Waiting for the dev server") || !strings.Contains(body, `http-equiv="refresh"`) {
		t.Errorf("%d %s", res.StatusCode, body)
	}
}

func post(t *testing.T, url string, body any) (*http.Response, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	res, err := http.Post(url, "application/json", strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res, out
}

func waitWake(t *testing.T, f *fixture) string {
	t.Helper()
	select {
	case text := <-f.woke:
		return text
	case <-time.After(5 * time.Second):
		t.Fatal("nobody woken")
		return ""
	}
}

func TestNotesWakeTheConversation(t *testing.T) {
	f := newFixture(t, http.NotFoundHandler())
	f.target(t)
	api := f.front.URL + "/c/conv1/review-app/__review/"
	png := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
	res, n := post(t, api+"notes", map[string]any{
		"kind": "area", "route": "/orders/42", "comment": "Too tight",
		"anchor":   map[string]string{"selector": "main > section.summary", "text": "Order total $1,204"},
		"doc":      map[string]float64{"x": 312, "y": 180, "w": 548, "h": 240},
		"overlaps": []map[string]string{{"selector": ".summary .total"}},
		"viewport": map[string]any{"w": 1440, "h": 900, "scheme": "dark"},
		"shot":     png,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("%d %v", res.StatusCode, n)
	}
	id, _ := n["id"].(string)
	if len(id) != 36 || n["num"] != float64(1) {
		t.Fatalf("id %q, num %v", id, n["num"])
	}
	text := waitWake(t, f)
	for _, want := range []string{
		"Review note #1 [" + id + "] (area) on /orders/42, viewport 1440×900 (dark):",
		"area 312,180 → 860,420 inside `main > section.summary` (\"Order total $1,204\")",
		"overlaps: `.summary .total`",
		"> Too tight",
		"Screenshot: " + filepath.Join(f.site.StateDir, "shots", id+".png"),
		"Source: /workspace/app (dev server :",
		"`review reply " + id + " \"…\"`",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in\n%s", want, text)
		}
	}
	if _, err := os.Stat(filepath.Join(f.site.StateDir, "shots", id+".png")); err != nil {
		t.Error(err)
	}

	// The label alone is refused, so a stale "#1" can't land on another note.
	if res, out := post(t, api+"notes/1/reply", map[string]any{"text": "x", "by": "agent"}); res.StatusCode != http.StatusNotFound || !strings.Contains(fmt.Sprint(out["error"]), id) {
		t.Errorf("reply by label: %d %v", res.StatusCode, out)
	}

	// Agent replies wake nobody; a user's reply wakes and reopens.
	post(t, api+"notes/"+id+"/resolve", map[string]any{"resolved": true, "by": "agent"})
	post(t, api+"notes/"+id+"/reply", map[string]any{"text": "fixed", "by": "agent"})
	post(t, api+"notes/"+id+"/reply", map[string]any{"text": "not on mobile"})
	if text := waitWake(t, f); !strings.HasPrefix(text, "Reply on review note #1 ["+id+"]") || !strings.Contains(text, "> not on mobile") {
		t.Errorf("reply wake: %s", text)
	}
	if n, _ := f.app.store.Get(id); n.Resolved || len(n.Thread) != 3 {
		t.Errorf("after reply: %+v", n)
	}
}

func TestAgentChangesAreUnreadUntilRead(t *testing.T) {
	f := newFixture(t, http.NotFoundHandler())
	api := f.front.URL + "/__review/"
	_, n := post(t, api+"notes", map[string]any{"kind": "point", "route": "/", "comment": "hi", "anchor": map[string]string{"selector": "h1"}})
	id, _ := n["id"].(string)
	unread := func() bool {
		got, _ := f.app.store.Get(id)
		return got.AgentAt != nil && (got.ReadAt == nil || got.AgentAt.After(*got.ReadAt))
	}
	if unread() {
		t.Error("a new note is unread")
	}
	post(t, api+"notes/"+id+"/reply", map[string]any{"text": "done", "by": "agent"})
	if !unread() {
		t.Error("an agent reply isn't unread")
	}
	post(t, api+"notes/"+id+"/read", map[string]any{})
	if unread() {
		t.Error("still unread after read")
	}
	post(t, api+"notes/"+id+"/resolve", map[string]any{"resolved": true, "by": "agent"})
	if !unread() {
		t.Error("an agent resolve isn't unread")
	}
}

func TestHidePinsAndShowThemAgain(t *testing.T) {
	f := newFixture(t, http.NotFoundHandler())
	api := f.front.URL + "/__review/"
	var ids []string
	for range 2 {
		_, n := post(t, api+"notes", map[string]any{"kind": "point", "route": "/", "comment": "hi", "anchor": map[string]string{"selector": "h1"}})
		id, _ := n["id"].(string)
		ids = append(ids, id)
	}
	hidden := func(id string) bool { n, _ := f.app.store.Get(id); return n.Hidden }
	post(t, api+"hide", map[string]any{"ids": ids, "hidden": true})
	if !hidden(ids[0]) || !hidden(ids[1]) {
		t.Error("hide didn't hide both pins")
	}
	post(t, api+"hide", map[string]any{"ids": ids[:1], "hidden": false})
	if hidden(ids[0]) || !hidden(ids[1]) {
		t.Error("showing one pin again changed the wrong notes")
	}
	if res, _ := post(t, api+"hide", map[string]any{"ids": []string{"nope"}, "hidden": true}); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown id: got %d, want 404", res.StatusCode)
	}
}

func TestSnapNeedsAnOpenPage(t *testing.T) {
	f := newFixture(t, http.NotFoundHandler())
	res, _ := post(t, f.front.URL+"/__review/snap", map[string]any{})
	if res.StatusCode != http.StatusConflict {
		t.Errorf("snap with no page: %d", res.StatusCode)
	}
}

func TestStorePrunesSnapsFirst(t *testing.T) {
	s, _ := openStore(t.TempDir())
	big := make([]byte, maxShotBytes/2+1)
	copy(big, "\x89PNG")
	n, _ := s.Add(Note{Kind: "point"}, "keep", big)
	if _, err := s.SaveSnap(big); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	if _, err := s.SaveSnap(big); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(s.dir, "shots"))
	names := []string{}
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 2 || names[0] != n.Shot {
		t.Errorf("after pruning: %v", names)
	}
}
