// conversation-router — fronts the agent-host Service and reverse-proxies each request
// to the agent-host pod that OWNS the conversation (status.hostPod on the Conversation
// CR). Go's httputil.ReverseProxy transparently handles HTTP, SSE, and WebSocket upgrades
// — the reason this is Go, not Python (the /c/<id>/ web-service proxy is WebSocket).
//
// Flow per request:
//  1. extract the conversation id (agui body threadId / path route);
//  2. look up its hostPod in the ownership cache (kept fresh by a CRD watch);
//  3. reverse-proxy to <hostPod>.<headless>.<ns>.svc:port. Unknown/unassigned or
//     non-scoped → any ready pod (the controller converges hostPod shortly).
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

type config struct {
	namespace    string
	upstreamPort int // agent-host container port
	listenAddr   string
	// The agent-host ClusterIP Service — fallback for non-scoped / unassigned / stale-IP
	// requests (load-balances to any ready pod). Replaces the old DEFAULT_POD ordinal.
	clusterIPService string
}

func configFromEnv() config {
	return config{
		namespace:        env("NAMESPACE", "agent-sandbox"),
		upstreamPort:     atoi(env("UPSTREAM_PORT", "8080")),
		listenAddr:       env("LISTEN_ADDR", ":8080"),
		clusterIPService: env("AGENT_HOST_SERVICE", "agent-host"),
	}
}

func main() {
	cfg := configFromEnv()
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	dyn, err := newDynamicClient()
	if err != nil {
		log.Fatalf("k8s client: %v", err)
	}
	cache := NewOwnershipCache()
	go cache.Run(ctx, dyn, cfg.namespace)

	creator := &dynamicCreator{dyn: dyn, namespace: cfg.namespace}
	srv := &http.Server{Addr: cfg.listenAddr, Handler: newRouter(cfg, cache, creator)}
	go func() {
		<-ctx.Done()
		sctx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = srv.Shutdown(sctx) // drains in-flight; SSE/WS closed by upstream on their own
	}()
	logf("conversation-router listening on %s (ns=%s svc=%s)", cfg.listenAddr, cfg.namespace, cfg.clusterIPService)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}

// newRouter builds the HTTP handler: resolve target (owner pod IP or ClusterIP fallback),
// reverse-proxy (HTTP/SSE/WS), and on a DIAL failure to the owner IP retry once via the
// fallback Service — covering a stale hostIP from a pod replaced this tick (the CR converges
// the correct IP shortly, and meanwhile any ready pod can serve via the mirror-hydrated state).
func newRouter(cfg config, cache *OwnershipCache, creator ConversationCreator) http.Handler {
	fallback := FallbackURL(cfg.clusterIPService, cfg.namespace, cfg.upstreamPort)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// FLEET-AGGREGATE routes must be answered from EVERY pod, not one. An agent-host serves the
		// conversation list from its in-memory session map, which (with podCap=1) holds only the
		// conversations that pod hosts — so proxying to a single pod returns a fraction of the
		// user's conversations and they appear to vanish between refreshes. See aggregate.go.
		// CREATE is served HERE, not proxied. The agent-host is capacity-bounded
		// (the controller leaves a conversation Pending when every pod is at cap),
		// so proxying create would make conversation N*C+1 uncreatable. Writing the
		// CR consults no agent-host. See create.go.
		if IsConversationCreate(r.Method, r.URL.Path) {
			serveConversationCreate(w, r, creator, ownerFrom(r))
			return
		}
		if IsFleetAggregate(r.Method, r.URL.Path) {
			ups := upstreamsFor(cfg, cache, fallback)
			if isSSE(r) {
				serveAggregatedSSE(w, r, ups)
			} else {
				serveAggregatedList(w, r, ups)
			}
			return
		}
		target := resolveTarget(cfg, cache, r, fallback)
		// Retry ONLY when the primary target is an owner IP (not already the fallback) AND
		// nothing has been written to the client yet (a dial error, pre-response). Streaming
		// bodies (SSE/WS) that fail mid-stream can't be safely retried — but a DIAL failure
		// happens before any bytes flow, so the guard below (headerWritten) makes it safe.
		canRetry := target.Host != fallback.Host
		serveVia(w, r, target, fallback, canRetry)
	})
}

// serveVia reverse-proxies r to `target`; on a connect/dial failure (upstream unreachable,
// pre-response) it retries once against `fallback` when `retry` is set. A failure AFTER the
// response has begun (headers written / stream started) is surfaced as-is — not retryable.
func serveVia(w http.ResponseWriter, r *http.Request, target, fallback *url.URL, retry bool) {
	tw := &trackingWriter{ResponseWriter: w}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1 // flush immediately: required for SSE (don't buffer the stream).
	proxy.ErrorHandler = func(ww http.ResponseWriter, rr *http.Request, e error) {
		if retry && !tw.wrote {
			// Owner IP unreachable before any bytes flowed (e.g. pod replaced) → serve via
			// the fallback Service (any ready pod). Recurse with retry=false so a fallback
			// failure returns a real 502.
			logf("proxy to %s failed pre-response (%v) — retrying via fallback %s", target.Host, e, fallback.Host)
			serveVia(ww, rr, fallback, fallback, false)
			return
		}
		logf("proxy to %s failed: %v", target.Host, e)
		http.Error(ww, "upstream unavailable", http.StatusBadGateway)
	}
	proxy.ServeHTTP(tw, r)
}

// trackingWriter records whether ANY response byte/header has been written, so the dial-fail
// retry only fires while the client response is still untouched (a retry after streaming
// started would duplicate/corrupt the body).
type trackingWriter struct {
	http.ResponseWriter
	wrote bool
}

func (t *trackingWriter) WriteHeader(code int) { t.wrote = true; t.ResponseWriter.WriteHeader(code) }
func (t *trackingWriter) Write(b []byte) (int, error) {
	t.wrote = true
	return t.ResponseWriter.Write(b)
}

// Flush lets SSE streaming pass through the tracking wrapper (httputil flushes per write).
func (t *trackingWriter) Flush() {
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack lets WebSocket upgrades (the /c/<id>/<svc> web-service proxy) pass through: a hijack
// takes over the conn, so mark the response as "written" (no retry possible after this).
func (t *trackingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := t.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	t.wrote = true
	return h.Hijack()
}

// resolveTarget decides the upstream URL for a request: the owner pod's IP when the
// conversation is scoped + assigned, else the ClusterIP fallback (non-scoped, unassigned,
// or unknown — the controller converges the owner shortly).
func resolveTarget(cfg config, cache *OwnershipCache, r *http.Request, fallback *url.URL) *url.URL {
	if IsNonScoped(r.URL.Path) {
		return fallback
	}
	convID := ""
	if IsAguiPost(r.Method, r.URL.Path) {
		convID = aguiThreadID(r) // reads + REPLACES the body so the upstream still gets it
	} else if id, ok := ConvIDFromPath(r.URL.Path); ok {
		convID = id
	}
	if convID != "" {
		if ip, ok := cache.HostIP(convID); ok {
			return TargetURL(ip, cfg.upstreamPort)
		}
	}
	return fallback
}

// aguiThreadID reads the POST /agui JSON body to get threadId, then restores the body on
// the request (so the reverse-proxy forwards the full, unconsumed body upstream).
func aguiThreadID(r *http.Request) string {
	if r.Body == nil {
		return ""
	}
	buf, err := io.ReadAll(r.Body)
	_ = r.Body.Close()
	if err != nil {
		return ""
	}
	r.Body = io.NopCloser(bytes.NewReader(buf)) // restore for the upstream
	r.ContentLength = int64(len(buf))
	var body struct {
		ThreadID string `json:"threadId"`
	}
	_ = json.Unmarshal(buf, &body)
	return body.ThreadID
}

// --- k8s client + unstructured helpers (used by cache.go) -------------------

func newDynamicClient() (dynamic.Interface, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		cfg, err = clientcmd.BuildConfigFromFlags("", clientcmd.RecommendedHomeFile)
		if err != nil {
			return nil, err
		}
	}
	return dynamic.NewForConfig(cfg)
}

func metav1ListOptions() metav1.ListOptions { return metav1.ListOptions{} }
func metav1WatchOptions(rv string) metav1.ListOptions {
	return metav1.ListOptions{ResourceVersion: rv, Watch: true}
}
func unstructuredNestedString(obj map[string]interface{}, fields ...string) (string, bool, error) {
	return unstructured.NestedString(obj, fields...)
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

// isSSE reports whether the caller asked for an event stream (the /conversations/events variant of
// a fleet-aggregate route) rather than the JSON list.
func isSSE(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream") ||
		strings.HasSuffix(r.URL.Path, "/events")
}

func logf(f string, a ...interface{}) { log.Printf(f, a...) }
