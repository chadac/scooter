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
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

type config struct {
	namespace       string
	headlessService string // agent-host pods' headless Service for stable DNS
	upstreamPort    int    // agent-host container port
	listenAddr      string
	// The pod to fall back to for non-scoped / unassigned requests. With a StatefulSet
	// this defaults to ordinal 0 (always present); overridable.
	defaultPod string
}

func configFromEnv() config {
	return config{
		namespace:       env("NAMESPACE", "agent-sandbox"),
		headlessService: env("AGENT_HOST_HEADLESS", "agent-host-headless"),
		upstreamPort:    atoi(env("UPSTREAM_PORT", "8080")),
		listenAddr:      env("LISTEN_ADDR", ":8080"),
		defaultPod:      env("DEFAULT_POD", "agent-host-0"),
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

	srv := &http.Server{Addr: cfg.listenAddr, Handler: newRouter(cfg, cache)}
	go func() {
		<-ctx.Done()
		sctx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = srv.Shutdown(sctx) // drains in-flight; SSE/WS closed by upstream on their own
	}()
	logf("conversation-router listening on %s (ns=%s headless=%s)", cfg.listenAddr, cfg.namespace, cfg.headlessService)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}

// newRouter builds the HTTP handler: resolve target, reverse-proxy (HTTP/SSE/WS).
func newRouter(cfg config, cache *OwnershipCache) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := resolveHost(cfg, cache, r)
		target := TargetURL(host, cfg.headlessService, cfg.namespace, cfg.upstreamPort)
		proxy := httputil.NewSingleHostReverseProxy(target)
		// FlushInterval -1 = flush immediately: required for SSE (don't buffer the stream).
		proxy.FlushInterval = -1
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, e error) {
			logf("proxy to %s failed: %v", target.Host, e)
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
		}
		proxy.ServeHTTP(w, r)
	})
}

// resolveHost decides which agent-host pod a request goes to.
func resolveHost(cfg config, cache *OwnershipCache, r *http.Request) string {
	if IsNonScoped(r.URL.Path) {
		return cfg.defaultPod
	}
	convID := ""
	if IsAguiPost(r.Method, r.URL.Path) {
		convID = aguiThreadID(r) // reads + REPLACES the body so the upstream still gets it
	} else if id, ok := ConvIDFromPath(r.URL.Path); ok {
		convID = id
	}
	if convID != "" {
		if h, ok := cache.Host(convID); ok {
			return h
		}
	}
	// Unknown/unassigned: send to the default pod; the controller assigns hostPod shortly
	// and subsequent requests route correctly.
	return cfg.defaultPod
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

func metav1ListOptions() metav1.ListOptions   { return metav1.ListOptions{} }
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
func logf(f string, a ...interface{}) { log.Printf(f, a...) }
