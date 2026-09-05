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
	"log/slog"
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
	// fallback is the upstream for non-scoped / unassigned / stale-IP requests, resolved once at
	// boot: the ClusterIP Service in cluster, or the single AGENT_HOST_URL in dev mode. Set in
	// main() after the mode is known; newRouter reads it rather than recomputing.
	fallback *url.URL
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
	setupLogging()
	log := logger("main")

	cfg := configFromEnv()
	// ctx is the PROCESS-lifetime context: cancelled on SIGTERM/SIGINT. It is handed to the
	// proxy layer so a cancellation caused by OUR shutdown can be told apart from a client
	// hanging up — see classifyProxyError.
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	// EXISTENCE + routing + create differ between cluster and the kube-less dev/e2e stack (see
	// devmode.go). The ownership cache is always constructed; in dev it is simply never Run, so
	// HostIP always misses and every request falls through to the single AGENT_HOST_URL.
	cache := NewOwnershipCache()
	var crs crLookup = cache
	var creator ConversationCreator
	if devModeEnabled() {
		u, err := agentHostURLFromEnv()
		if err != nil {
			log.Error("ROUTER_DEV_MODE misconfigured", errAttr(err))
			os.Exit(1)
		}
		dc, err := OpenDevCreator(ctx, storeDSNFromEnv())
		if err != nil {
			log.Error("ROUTER_DEV_MODE dev creator init failed", errAttr(err))
			os.Exit(1)
		}
		defer dc.Close()
		cfg.fallback = u
		crs = allExisting{}
		creator = dc
		log.Warn("ROUTER_DEV_MODE: kube-less single-host stack (no CRD watch, existence from store)",
			slog.String("agent_host_url", u.String()))
	} else {
		dyn, err := newDynamicClient()
		if err != nil {
			log.Error("k8s client init failed", errAttr(err))
			os.Exit(1)
		}
		go cache.Run(ctx, dyn, cfg.namespace)
		creator = &dynamicCreator{dyn: dyn, namespace: cfg.namespace}
		cfg.fallback = FallbackURL(cfg.clusterIPService, cfg.namespace, cfg.upstreamPort)
	}

	// Read-only Postgres handle on the agent_host database (conversation metadata). Optional:
	// when no DSN is configured the router proxies the list to the pods exactly as before. When
	// present, GET /conversations is served straight from here (see newRouter).
	var store *Store
	if dsn := storeDSNFromEnv(); dsn != "" {
		s, err := OpenStore(ctx, dsn)
		if err != nil {
			log.Warn("postgres read store unavailable (list falls back to fleet aggregate)", errAttr(err))
		} else {
			store = s
			defer store.Close()
			// Prove the SELECT grant at boot — a mis-provisioned read-only role fails HERE
			// (loudly) rather than silently when the list is first served.
			vctx, vcancel := context.WithTimeout(ctx, verifyTimeout)
			if n, err := store.CountConversations(vctx); err != nil {
				log.Warn("postgres read store verify failed (list falls back to fleet aggregate)", errAttr(err))
			} else {
				log.Info("postgres read store connected", slog.Int64("conversations", n))
			}
			vcancel()
		}
	}

	// PRODUCTION-ONLY narrow write handle: lets the router persist a star/title PATCH for an IDLE
	// conversation (no owner pod) directly, instead of proxying it to an arbitrary ready pod that
	// 404s (it doesn't hold the conversation). NOT opened in dev mode — there the single agent-host
	// behind the fallback is the authoritative writer and the CRD watch that tells idle from live
	// does not exist, so metadata PATCHes proxy to it exactly as before (agent-host hydrates an
	// idle conversation on demand). Optional: no DSN / open failure => metadata PATCHes proxy too.
	var writeStore *WriteStore
	if !devModeEnabled() {
		if dsn := storeDSNFromEnv(); dsn != "" {
			ws, err := OpenWriteStore(ctx, dsn)
			if err != nil {
				log.Warn("postgres write store unavailable (metadata PATCH falls back to proxy)", errAttr(err))
			} else {
				writeStore = ws
				defer writeStore.Close()
				log.Info("postgres write store connected (idle star/title served here)")
			}
		}
	}

	// Read-only handle on the webhooks database (resource_links) — the sidebar enrichment for
	// GET /conversations. Optional and independent of the metadata store: no links DB => bare
	// rows (no sources/links), never a failure.
	var links *LinkStore
	if dsn := linkStoreDSNFromEnv(); dsn != "" {
		l, err := OpenLinkStore(ctx, dsn)
		if err != nil {
			log.Warn("links read store unavailable (list served without enrichment)", errAttr(err))
		} else {
			links = l
			defer links.Close()
			log.Info("links read store connected")
		}
	}

	// The live conversation-list push: a single LISTEN connection on the agent_host DB fans NOTIFYs
	// out to SSE subscribers (see events.go). No-op when store is nil (dev/pg-less) — the hub stays
	// empty and GET /conversations/events reports unavailable, same as the JSON list.
	hub := newSSEHub()
	go runConversationListener(ctx, store, links, crs, hub)

	srv := &http.Server{Addr: cfg.listenAddr, Handler: newRouter(ctx, cfg, cache, crs, creator, store, writeStore, links, hub)}
	go func() {
		<-ctx.Done()
		log.Info("shutdown signalled, draining")
		sctx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = srv.Shutdown(sctx) // drains in-flight; SSE/WS closed by upstream on their own
	}()
	log.Info("listening",
		slog.String("listen_addr", cfg.listenAddr),
		slog.String("namespace", cfg.namespace),
		slog.String("agent_host_service", cfg.clusterIPService))
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("serve failed", errAttr(err))
		os.Exit(1)
	}
	log.Info("stopped")
}

// newRouter builds the HTTP handler: resolve target (owner pod IP or ClusterIP fallback),
// reverse-proxy (HTTP/SSE/WS), and on a DIAL failure to the owner IP retry once via the
// fallback Service — covering a stale hostIP from a pod replaced this tick (the CR converges
// the correct IP shortly, and meanwhile any ready pod can serve via the mirror-hydrated state).
func newRouter(shutdownCtx context.Context, cfg config, cache *OwnershipCache, crs crLookup, creator ConversationCreator, store *Store, writeStore *WriteStore, links *LinkStore, hub *sseHub) http.Handler {
	fallback := cfg.fallback
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The conversation LIST and its live events stream are served HERE from Postgres, not
		// proxied. An agent-host only knows the conversations it currently hosts (with podCap=1 the
		// controller spreads them one-per-pod), so no single pod can answer "all of this user's
		// conversations" — the durable store can. The JSON list reads a snapshot; the events stream
		// LISTENs for NOTIFYs (see list.go / events.go). Both require the store: without it (a
		// misconfigured deploy) there is no correct answer, so report 503 rather than a wrong slice.
		// CREATE is served HERE too, not proxied. The agent-host is capacity-bounded
		// (the controller leaves a conversation Pending when every pod is at cap),
		// so proxying create would make conversation N*C+1 uncreatable. Writing the
		// CR consults no agent-host. See create.go.
		if IsConversationCreate(r.Method, r.URL.Path) {
			serveConversationCreate(w, r, creator, ownerFrom(r))
			return
		}
		if IsConversationListRoute(r.Method, r.URL.Path) {
			if store == nil {
				http.Error(w, "conversation store unavailable", http.StatusServiceUnavailable)
				return
			}
			if isSSE(r) {
				serveConversationEvents(w, r, store, links, crs, hub)
			} else {
				serveConversationList(w, r, store, links, crs)
			}
			return
		}
		// A star/title PATCH for an IDLE conversation is served HERE from the store, not proxied.
		// An idle/suspended conversation has no owner pod, so proxying lands on an arbitrary ready
		// pod that doesn't hold it in memory and 404s (agent-host's mutableFor is memory-only). A
		// LIVE conversation (owner pod present in the cache) is NOT intercepted — it falls through
		// to the proxy below and is forwarded to its owner, which stays the single writer of its
		// in-memory copy (see metadata.go / owners.toml). writeStore is nil in dev / when no write
		// grant is configured, so this whole path degrades to the proxy exactly as before.
		if writeStore != nil && store != nil {
			if field, id, ok := MetadataPatch(r.Method, r.URL.Path); ok {
				if _, hasOwner := cache.HostIP(id); !hasOwner {
					serveConversationMetadataPatch(w, r, field, id, store, writeStore, crs)
					return
				}
			}
		}
		// convID is resolved ONCE here and threaded into the proxy layer, so every line a
		// request produces carries conversation_id — the field the cross-service query joins on.
		convID, target := resolveTargetFor(cfg, cache, r, fallback)
		// Retry ONLY when the primary target is an owner IP (not already the fallback) AND
		// nothing has been written to the client yet (a dial error, pre-response). Streaming
		// bodies (SSE/WS) that fail mid-stream can't be safely retried — but a DIAL failure
		// happens before any bytes flow, so the guard below (headerWritten) makes it safe.
		canRetry := target.Host != fallback.Host
		serveVia(shutdownCtx, w, r, target, fallback, canRetry, convID)
	})
}

// serveVia reverse-proxies r to `target`; on a connect/dial failure (upstream unreachable,
// pre-response) it retries once against `fallback` when `retry` is set. A failure AFTER the
// response has begun (headers written / stream started) is surfaced as-is — not retryable.
func serveVia(shutdownCtx context.Context, w http.ResponseWriter, r *http.Request, target, fallback *url.URL, retry bool, convID string) {
	log := logger("proxy")
	tw := &trackingWriter{ResponseWriter: w}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1 // flush immediately: required for SSE (don't buffer the stream).
	proxy.ErrorHandler = func(ww http.ResponseWriter, rr *http.Request, e error) {
		kind := classifyProxyError(e, shutdownCtx, rr.Context())
		fields := []any{
			convAttr(convID),
			slog.String("upstream", target.Host),
			slog.String("method", rr.Method),
			slog.String("path", rr.URL.Path),
			slog.String("reason", kind.String()),
			errAttr(e),
		}

		// ROUTINE ENDINGS ARE NOT ERRORS. An SSE reader navigating away or a finished body
		// surfaces here as context.Canceled / io.EOF; that was ~55 false errors a day, burying
		// the real ones. There is also nobody left to receive a 502, and writing one after the
		// stream started would corrupt it — so we log and return.
		if kind.routine() {
			log.Debug("stream ended", fields...)
			return
		}
		if kind == proxyErrShutdown {
			// Expected during a rollout, but it IS us dropping somebody's in-flight request —
			// visible at warn rather than hidden at debug.
			log.Warn("request cancelled by shutdown", fields...)
			return
		}

		if retry && !tw.wrote {
			// Owner IP unreachable before any bytes flowed (e.g. pod replaced) → serve via
			// the fallback Service (any ready pod). Recurse with retry=false so a fallback
			// failure returns a real 502.
			log.Warn("upstream unreachable, retrying via fallback",
				append(fields, slog.String("fallback", fallback.Host),
					slog.Bool("dial_failure", isDialFailure(e)))...)
			serveVia(shutdownCtx, ww, rr, fallback, fallback, false, convID)
			return
		}
		// A genuine proxy failure with no retry left: the client gets a real 502.
		log.Error("proxy failed",
			append(fields, slog.Bool("response_started", tw.wrote),
				slog.Bool("dial_failure", isDialFailure(e)))...)
		if tw.wrote {
			// Headers already went out; a 502 now would be a protocol violation. The truncated
			// stream is all the client can be told.
			return
		}
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
	_, u := resolveTargetFor(cfg, cache, r, fallback)
	return u
}

// resolveTargetFor is resolveTarget plus the conversation id it resolved, so the caller can
// attach `conversation_id` to every log line the request produces. Returns "" for a non-scoped
// or unidentifiable request (healthz, a malformed agui body) — the id field is then omitted
// rather than logged empty.
func resolveTargetFor(cfg config, cache *OwnershipCache, r *http.Request, fallback *url.URL) (string, *url.URL) {
	if IsNonScoped(r.URL.Path) {
		return "", fallback
	}
	convID := ""
	if IsAguiPost(r.Method, r.URL.Path) {
		convID = aguiThreadID(r) // reads + REPLACES the body so the upstream still gets it
	} else if id, ok := ConvIDFromPath(r.URL.Path); ok {
		convID = id
	}
	if convID != "" {
		if ip, ok := cache.HostIP(convID); ok {
			return convID, TargetURL(ip, cfg.upstreamPort)
		}
	}
	return convID, fallback
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
