package main

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"html"
	"io"
	"log"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed static/overlay.js
var overlayJS []byte

// maxRewrite: larger bodies stream through unrewritten.
const maxRewrite = 2 << 20

// devUnit runs the `review target --run` dev server.
const devUnit = "webservice-review-dev"

// App is review-app: the dev server's proxy plus the notes API.
type App struct {
	site  Site
	store *Store
	hub   *Hub
	waker *Waker
	snaps *Snaps

	mu      sync.Mutex
	target  *Target
	seen    string // config.json as last read, to notice edits
	loaded  bool
	proxy   *httputil.ReverseProxy
	rw      *Rewriter
	devSpec string // the dev command line last started

	runCmd func(name string, args ...string) ([]byte, error)
}

func newApp(site Site, store *Store) *App {
	a := &App{
		site:  site,
		store: store,
		hub:   newHub(),
		waker: &Waker{site: site, client: &http.Client{Timeout: 15 * time.Second}},
		snaps: newSnaps(),
		runCmd: func(name string, args ...string) ([]byte, error) {
			return exec.Command(name, args...).CombinedOutput()
		},
	}
	store.onChange = func(st State) { a.hub.Publish("notes", st) }
	return a
}

// current reloads config.json on change, restarting the dev server.
func (a *App) current() *Target {
	raw, _ := os.ReadFile(a.site.ConfigPath())
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.loaded && string(raw) == a.seen {
		return a.target
	}
	a.loaded, a.seen = true, string(raw)
	t, err := readTarget(a.site.ConfigPath())
	if err != nil {
		log.Printf("config: %v", err)
	}
	a.target = t
	a.proxy, a.rw = nil, nil
	if t != nil {
		a.proxy = a.newProxy(t)
		a.rw = newRewriter(t.Port)
	}
	a.ensureDevLocked(t)
	return t
}

func (a *App) ensureDevLocked(t *Target) {
	spec := ""
	if t != nil && t.Run != "" {
		spec = fmt.Sprintf("%s\x00%s\x00%d\x00%v", t.Run, t.Cwd, t.Port, t.Env)
	}
	if spec == a.devSpec {
		return
	}
	if a.devSpec != "" || spec != "" {
		_, _ = a.runCmd("systemctl", "stop", devUnit)
	}
	a.devSpec = spec
	if spec == "" {
		return
	}
	args := []string{"--unit=" + devUnit, "--collect", "--quiet", "--property=KillMode=mixed"}
	if t.Cwd != "" {
		args = append(args, "--working-directory="+t.Cwd)
	}
	for k, v := range a.devEnv(t) {
		args = append(args, "--setenv="+k+"="+v)
	}
	args = append(args, "/bin/sh", "-c", "exec "+t.Run)
	if out, err := a.runCmd("systemd-run", args...); err != nil {
		log.Printf("start dev server: %v: %s", err, out)
	}
}

// devEnv tells the dev server where the browser will see it.
func (a *App) devEnv(t *Target) map[string]string {
	e := map[string]string{}
	for k, v := range t.Env {
		e[k] = v
	}
	e["PORT"] = strconv.Itoa(t.Port)
	e["REVIEW_BASE"] = a.site.AppBase() + "/"
	if a.site.Public != nil {
		e["REVIEW_PUBLIC_URL"] = a.site.Public.String() + a.site.AppBase() + "/"
	}
	return e
}

func (a *App) stopDev() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.devSpec != "" {
		_, _ = a.runCmd("systemctl", "stop", devUnit)
		a.devSpec = ""
	}
}

// public is the browser's origin for this request.
func (a *App) public(r *http.Request) *url.URL {
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		proto := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]))
		if proto != "http" && proto != "https" {
			proto = "https"
			if a.site.Public != nil {
				proto = a.site.Public.Scheme
			}
		}
		return &url.URL{Scheme: proto, Host: strings.TrimSpace(strings.Split(h, ",")[0])}
	}
	// The headless browser in the pod reaches the proxy directly.
	if strings.HasPrefix(r.Host, "127.0.0.1:") || strings.HasPrefix(r.Host, "localhost:") {
		return &url.URL{Scheme: "http", Host: r.Host}
	}
	return a.site.Public
}

type ctxKey struct{}

func (a *App) newProxy(t *Target) *httputil.ReverseProxy {
	upstream := &url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(t.Port)}
	local := "http://localhost:" + strconv.Itoa(t.Port)
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pub, _ := pr.In.Context().Value(ctxKey{}).(*url.URL)
			pr.SetURL(upstream)
			// Dev servers' host checks (Vite's allowedHosts) accept localhost.
			pr.Out.Host = "localhost:" + strconv.Itoa(t.Port)
			// Uncompressed, so bodies can be rewritten in place.
			pr.Out.Header.Set("Accept-Encoding", "identity")
			pr.Out.Header.Set("X-Forwarded-Prefix", a.site.AppBase())
			if pub != nil {
				pr.Out.Header.Set("X-Forwarded-Host", pub.Host)
				pr.Out.Header.Set("X-Forwarded-Proto", pub.Scheme)
				origin := pub.Scheme + "://" + pub.Host
				for _, h := range []string{"Origin", "Referer"} {
					if v := pr.In.Header.Get(h); strings.HasPrefix(v, origin) {
						pr.Out.Header.Set(h, local+strings.TrimPrefix(v, origin))
					}
				}
			}
		},
		ModifyResponse: a.modify,
		ErrorHandler:   a.upstreamDown,
		FlushInterval:  -1,
	}
}

var cookieDomain = regexp.MustCompile(`(?i);\s*domain=\.?(localhost|127\.0\.0\.1|0\.0\.0\.0)\s*(;|$)`)

func (a *App) modify(resp *http.Response) error {
	if resp.StatusCode == http.StatusSwitchingProtocols {
		return nil
	}
	pub, _ := resp.Request.Context().Value(ctxKey{}).(*url.URL)
	a.mu.Lock()
	rw := a.rw
	a.mu.Unlock()
	if rw == nil {
		return nil
	}
	h := resp.Header
	h.Del("X-Frame-Options")
	for _, name := range []string{"Content-Security-Policy", "Content-Security-Policy-Report-Only"} {
		if vs := h.Values(name); len(vs) > 0 {
			h.Del(name)
			for _, v := range vs {
				h.Add(name, relaxCSP(v))
			}
		}
	}
	for _, name := range []string{"Location", "Content-Location", "Refresh", "Link"} {
		if v := h.Get(name); v != "" {
			h.Set(name, rw.String(v, pub))
		}
	}
	if v := h.Get("Access-Control-Allow-Origin"); v != "" && rw.IsLocal(v) && pub != nil {
		h.Set("Access-Control-Allow-Origin", pub.Scheme+"://"+pub.Host)
	}
	if cs := h.Values("Set-Cookie"); len(cs) > 0 {
		h.Del("Set-Cookie")
		for _, c := range cs {
			h.Add("Set-Cookie", cookieDomain.ReplaceAllString(c, "$2"))
		}
	}
	return a.rewriteBody(resp, rw, pub)
}

func textual(ct string) (isText, isHTML bool) {
	mt, _, _ := mime.ParseMediaType(ct)
	switch {
	case mt == "text/html":
		return true, true
	case mt == "text/css", mt == "application/json", strings.HasSuffix(mt, "javascript"), strings.HasSuffix(mt, "+json"):
		return true, false
	}
	return false, false
}

func isDocument(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Dest") {
	case "", "document", "iframe":
		return true
	}
	return false
}

func (a *App) rewriteBody(resp *http.Response, rw *Rewriter, pub *url.URL) error {
	isText, isHTML := textual(resp.Header.Get("Content-Type"))
	if !isText || resp.Header.Get("Content-Encoding") != "" || resp.Request.Method == http.MethodHead ||
		resp.ContentLength > maxRewrite {
		return nil
	}
	head, err := io.ReadAll(io.LimitReader(resp.Body, maxRewrite+1))
	if err != nil {
		return err
	}
	if len(head) > maxRewrite {
		resp.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(head), resp.Body), resp.Body}
		return nil
	}
	resp.Body.Close()
	body := rw.Bytes(head, pub)
	if isHTML && isDocument(resp.Request) {
		body = inject(relaxMetaCSP(body), a.overlayTag())
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	return nil
}

func (a *App) overlayTag() string {
	base := html.EscapeString(a.site.AppBase())
	return fmt.Sprintf(`<script src="%s/__review/overlay.js" data-app-base="%s" data-shell-base="%s"></script>`,
		base, base, html.EscapeString(a.site.ShellBase()))
}

func (a *App) upstreamDown(w http.ResponseWriter, r *http.Request, err error) {
	t := a.current()
	if !isDocument(r) || t == nil {
		http.Error(w, "dev server unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	logs := ""
	if t.Run != "" {
		out, _ := a.runCmd("journalctl", "-u", devUnit, "-n", "15", "--no-pager", "--no-hostname", "-o", "cat")
		logs = string(out)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusBadGateway)
	fmt.Fprintf(w, waitingPage, "Waiting for the dev server",
		fmt.Sprintf("<p>Nothing answers on port <code>%d</code> in the sandbox yet (%s). This page retries on its own.</p>",
			t.Port, html.EscapeString(err.Error()))+
			ifLogs(logs))
}

func ifLogs(s string) string {
	if strings.TrimSpace(s) == "" {
		return ""
	}
	return "<p>Last lines of <code>" + devUnit + "</code>:</p><pre>" + html.EscapeString(s) + "</pre>"
}

func (a *App) noTarget(w http.ResponseWriter, r *http.Request) {
	if !isDocument(r) {
		http.Error(w, "no app to review yet", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, waitingPage, "No app to review yet",
		"<p>Ask Scooter to point the review at your app:</p><pre>review target 5173\nreview target --run \"npm run dev\" --cwd /workspace/my-app --port 5173</pre>"+
			"<p>The app must serve under <code>"+html.EscapeString(a.site.AppBase())+"/</code> (Vite <code>--base</code>, Next <code>basePath</code>, …).</p>")
}

const waitingPage = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>%[1]s</title><style>
:root{color-scheme:light dark;font:15px/1.5 system-ui,sans-serif}
body{max-width:40rem;margin:4rem auto;padding:0 1.5rem}
pre{background:color-mix(in srgb,currentColor 8%%,transparent);padding:.75rem;border-radius:6px;overflow:auto;font-size:13px}
</style></head><body><h1>%[1]s</h1>%[2]s</body></html>`

// ServeHTTP serves the review API and proxies the rest.
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if rest, ok := a.apiPath(r.URL.Path); ok {
		a.api(w, r, rest)
		return
	}
	t := a.current()
	a.mu.Lock()
	p := a.proxy
	a.mu.Unlock()
	if t == nil || p == nil {
		a.noTarget(w, r)
		return
	}
	p.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, a.public(r))))
}

// apiPath: browsers use <base>/__review/, the CLI bare /__review/.
func (a *App) apiPath(p string) (string, bool) {
	for _, base := range []string{a.site.AppBase() + "/__review/", "/__review/"} {
		if strings.HasPrefix(p, base) {
			return strings.TrimPrefix(p, base), true
		}
	}
	return "", false
}
