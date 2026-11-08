// conversation-router fronts the agent-host Service and reverse-proxies each request to
// the agent-host pod that owns the conversation (the `conversations` row's host_pod).
// httputil.ReverseProxy handles HTTP, SSE and WebSocket upgrades alike.
//
// Flow per request:
//  1. extract the conversation id (agui body threadId / path route);
//  2. resolve its pod from the row, claiming if unassigned;
//  3. proxy there; only conversation-less requests go to any pod.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	// The agent-host ClusterIP Service, for requests that name no conversation.
	clusterIPService string
	// The ClusterIP Service in cluster, or AGENT_HOST_URL in dev mode.
	fallback *url.URL
	// Parent domain of the per-conversation service hosts (<label>.<domain>); empty disables them.
	sandboxDomain string
	// The sandbox listener's address, the only one serving sandbox hosts (see sandboxhost.go).
	sandboxListenAddr string
	// The sandbox self-access listener's address (SELF_LISTEN_ADDR); empty disables it.
	selfListenAddr string
	// Whether sandbox hosts are proxied straight to the pod (sandboxdirect.go) rather than
	// through the agent-host. SANDBOX_DIRECT=0 turns it off.
	sandboxDirect bool
}

func configFromEnv() config {
	return config{
		namespace:         env("NAMESPACE", "agent-sandbox"),
		upstreamPort:      atoi(env("UPSTREAM_PORT", "8080")),
		listenAddr:        env("LISTEN_ADDR", ":8080"),
		clusterIPService:  env("AGENT_HOST_SERVICE", "agent-host"),
		sandboxDomain:     env("SANDBOX_DOMAIN", ""),
		sandboxListenAddr: env("SANDBOX_LISTEN_ADDR", ":8082"),
		selfListenAddr:    env("SELF_LISTEN_ADDR", ""),
		sandboxDirect:     env("SANDBOX_DIRECT", "1") != "0",
	}
}

func main() {
	setupLogging()
	log := logger("main")

	cfg := configFromEnv()
	if err := validateListenAddrs(cfg); err != nil {
		log.Error("invalid listener config", errAttr(err))
		os.Exit(1)
	}
	// ctx is the process-lifetime context, handed to the proxy layer so a shutdown cancellation can be told apart from a client hanging up (see classifyProxyError).
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	var creator ConversationCreator
	// Nil in dev mode, where every request goes to AGENT_HOST_URL.
	var pods *ReadyPods
	// Body-`owner` trust for in-cluster callers; nil outside a cluster, where a body owner is never honored.
	var trusted TrustedCaller
	// Verifies spawn callers; nil disables POST /conversations/{id}/spawns.
	var spawner TrustedCaller
	// Verifies owned-read callers; nil disables GET /conversations/{id}/owned.
	var reader TrustedCaller
	// Verifies folder services; nil leaves locked folders unchangeable.
	var folderServices FolderService
	// The apiserver credentials, for the self-access TokenReview; nil in dev mode.
	var kubeCfg *rest.Config
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
		creator = dc
		log.Warn("ROUTER_DEV_MODE: kube-less single-host stack (no CRD watch, single upstream)",
			slog.String("agent_host_url", u.String()))
	} else {
		dyn, kc, err := newDynamicClient()
		kubeCfg = kc
		if err != nil {
			log.Error("k8s client init failed", errAttr(err))
			os.Exit(1)
		}
		pods = NewReadyPods()
		go pods.Run(ctx, dyn, cfg.namespace)
		// The row is the conversation; rowCreator replaces this once the write store connects.
		creator = unavailableCreator{}
		cfg.fallback = FallbackURL(cfg.clusterIPService, cfg.namespace, cfg.upstreamPort)
		trusted = buildTrustedCaller(kubeCfg, log)
		spawner = buildSpawner(kubeCfg, log)
		reader = buildReader(kubeCfg, log)
		folderServices = buildFolderServices(kubeCfg, log)
	}

	// Optional read-only Postgres handle on the agent_host database, from which GET /conversations is served.
	var store *Store
	if dsn := storeDSNFromEnv(); dsn != "" {
		s, err := OpenStore(ctx, dsn)
		if err != nil {
			log.Warn("postgres read store unavailable (list falls back to fleet aggregate)", errAttr(err))
		} else {
			store = s
			defer store.Close()
			// Prove the SELECT grant at boot rather than when the list is first served.
			vctx, vcancel := context.WithTimeout(ctx, verifyTimeout)
			if n, err := store.CountConversations(vctx); err != nil {
				log.Warn("postgres read store verify failed (list falls back to fleet aggregate)", errAttr(err))
			} else {
				log.Info("postgres read store connected", slog.Int64("conversations", n))
			}
			vcancel()
		}
	}

	// The write handle: star/title PATCHes in both modes, plus cluster create and assignment.
	var writeStore *WriteStore
	if dsn := storeDSNFromEnv(); dsn != "" {
		ws, err := OpenWriteStore(ctx, dsn)
		if err != nil {
			log.Warn("postgres write store unavailable (star/title PATCH refused)", errAttr(err))
		} else {
			writeStore = ws
			defer writeStore.Close()
			log.Info("postgres write store connected (star/title served here)")
		}
	}

	// The cluster path creates by inserting the row; dev's creator already does.
	if !devModeEnabled() {
		if writeStore != nil {
			creator = rowCreator{rows: writeStore}
		} else {
			log.Error("no write store: conversation create is refused")
		}
	}

	// Optional read-only handle on the webhooks database for link enrichment; without it the list serves bare rows.
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

	// Optional read-only handle on the awaiting-input database a contrib provides; without it no "!".
	if dsn := awaitingStoreDSNFromEnv(); dsn != "" {
		a, err := OpenAwaitingStore(ctx, dsn)
		if err != nil {
			log.Warn("awaiting-input read store unavailable (list served without the \"!\")", errAttr(err))
		} else {
			defer a.Close()
			if store != nil {
				store.awaiting = a
			}
			if writeStore != nil {
				writeStore.awaiting = a
			}
			log.Info("awaiting-input read store connected")
		}
	}

	var resolver ownerResolver
	if pods != nil && writeStore != nil {
		assigner := NewAssigner(&PgAssignStore{pool: writeStore.pool}, pods)
		go runAssignListener(ctx, writeStore.pool.Config().ConnConfig, assigner)
		resolver = assigner
		log.Info("routing by the conversations row")
	} else if pods != nil {
		log.Error("no write store: conversations cannot be assigned, routing to any pod")
	}

	// The live conversation-list push: one LISTEN connection per source database fans NOTIFYs
	// out to SSE subscribers — conversation rows from agent_host (events.go), link changes from
	// webhooks (linkevents.go), waits from awaiting-input (awaiting.go), all pushed as one upsert frame.
	hub := newSSEHub()
	var direct *directProxy
	if cfg.sandboxDomain != "" && cfg.sandboxDirect {
		direct = newDirectProxy()
	}
	go runConversationListener(ctx, store, links, hub, direct.invalidate)
	go runLinkListener(ctx, store, links, hub)
	go runAwaitingListener(ctx, store, links, hub)
	go runFolderListener(ctx, store, hub)

	handler := newRouter(ctx, cfg, resolver, creator, trusted, spawner, reader, folderServices, store, writeStore, links, hub)
	mainGate, sandboxGate := buildGateways(kubeCfg, log)
	srv := &http.Server{Addr: cfg.listenAddr, Handler: guarded(mainGate, handler)}
	if self := buildSelfServer(kubeCfg, cfg, store, handler, log); self != nil {
		go func() {
			<-ctx.Done()
			sctx, c := context.WithTimeout(context.Background(), 10*time.Second)
			defer c()
			_ = self.Shutdown(sctx)
		}()
		go func() {
			if err := self.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Error("self-access listener failed", errAttr(err))
				os.Exit(1)
			}
		}()
	}
	if cfg.sandboxDomain != "" {
		// The public wildcard Ingress points here, and this port serves sandbox hosts only.
		sb := &http.Server{Addr: cfg.sandboxListenAddr, Handler: guarded(sandboxGate, newSandboxRouter(ctx, cfg, resolver, store, direct))}
		go func() {
			<-ctx.Done()
			sctx, c := context.WithTimeout(context.Background(), 10*time.Second)
			defer c()
			_ = sb.Shutdown(sctx)
		}()
		go func() {
			log.Info("sandbox listener", slog.String("listen_addr", cfg.sandboxListenAddr), slog.String("sandbox_domain", cfg.sandboxDomain))
			if err := sb.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Error("sandbox listener failed", errAttr(err))
				os.Exit(1)
			}
		}()
	}
	go func() {
		<-ctx.Done()
		log.Info("shutdown signalled, draining")
		sctx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = srv.Shutdown(sctx) // drains in-flight requests
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

// newRouter builds the HTTP handler: resolve the target, reverse-proxy, and on a dial failure to the owner IP retry once via the fallback Service.
func newRouter(shutdownCtx context.Context, cfg config, resolver ownerResolver, creator ConversationCreator, trusted, spawner, reader TrustedCaller, folderServices FolderService, store *Store, writeStore *WriteStore, links *LinkStore, hub *sseHub) http.Handler {
	fallback := cfg.fallback
	// A typed-nil *Store in an interface is not nil.
	var parents parentLookup
	var owned ownedListing
	if store != nil {
		parents, owned = store, store
	}
	limiter := newSpawnLimiter(atoi(env("SPAWNS_PER_SOURCE_PER_HOUR", "10")), time.Hour)
	var h http.HandlerFunc
	// The first message re-enters this handler to be routed.
	self := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h(w, r) })
	deliver := internalDeliver(self, identityConfigFromEnv())
	get := internalGet(self, identityConfigFromEnv())
	h = func(w http.ResponseWriter, r *http.Request) {
		// Only the router's sandbox listener may mark a request as host-routed.
		r.Header.Del(SandboxHostHeader)
		// Sandbox hosts are served only by the sandbox listener (newSandboxRouter); one that
		// reaches this listener is misrouted and gets nothing, least of all the API.
		if IsSandboxDomainHost(r.Host, cfg.sandboxDomain) {
			http.NotFound(w, r)
			return
		}
		// Create, the conversation list and its events stream are served here rather than proxied: no single agent-host pod knows every conversation, and a capacity-bound pod cannot create one (see create.go, list.go, events.go).
		if IsConversationCreate(r.Method, r.URL.Path) {
			serveConversationCreate(w, r, creator, ownerFrom(r), trusted)
			return
		}
		// Spawn is served here too (see spawn.go).
		if sourceID, ok := ConversationSpawn(r.Method, r.URL.Path); ok {
			serveConversationSpawn(w, r, creator, parents, sourceID, spawner, limiter, deliver)
			return
		}
		// So are owned reads (see ownedread.go).
		if sourceID, targetID, ok := OwnedRead(r.Method, r.URL.Path); ok {
			serveOwnedRead(w, r, owned, sourceID, targetID, reader, get)
			return
		}
		// Subagent create is served here too (see subagent.go).
		if parentID, ok := SubagentCreate(r.Method, r.URL.Path); ok {
			serveSubagentCreate(w, r, creator, parents, parentID, ownerFrom(r), trusted)
			return
		}
		if IsOwnerEventPost(r.Method, r.URL.Path) {
			if writeStore == nil {
				writeJSONError(w, http.StatusServiceUnavailable, "conversation store unavailable")
				return
			}
			serveOwnerEvent(w, r, writeStore, folderServices)
			return
		}
		if IsConversationListRoute(r.Method, r.URL.Path) {
			if store == nil {
				http.Error(w, "conversation store unavailable", http.StatusServiceUnavailable)
				return
			}
			if isSSE(r) {
				serveConversationEvents(w, r, store, links, hub)
			} else {
				serveConversationList(w, r, store, links)
			}
			return
		}
		// Folders and stars are per-user, served here (folders.go).
		folderID, isFolders := FolderRoute(r.URL.Path)
		placeID, isPlace := PlacementPut(r.Method, r.URL.Path)
		if field, id, ok := MetadataPatch(r.Method, r.URL.Path); ok && field == "starred" {
			placeID, isPlace = id, true
		}
		if isFolders || isPlace {
			if writeStore == nil || store == nil {
				writeJSONError(w, http.StatusServiceUnavailable, "conversation store unavailable")
				return
			}
			if isFolders {
				serveFolders(w, r, folderID, writeStore, folderServices)
			} else {
				servePlacement(w, r, placeID, store, writeStore, folderServices)
			}
			return
		}
		if field, id, ok := MetadataPatch(r.Method, r.URL.Path); ok {
			if routerServesPatch(r.Context(), resolver, field, id) {
				if writeStore == nil || store == nil {
					writeJSONError(w, http.StatusServiceUnavailable, "conversation store unavailable")
					return
				}
				serveConversationMetadataPatch(w, r, field, id, store, writeStore)
				return
			}
		}
		// convID is resolved once and threaded into the proxy layer so every log line carries conversation_id.
		convID, target, err := resolveTargetFor(cfg, resolver, r, fallback)
		if errors.Is(err, ErrNoPods) {
			w.Header().Set("Retry-After", "2")
			http.Error(w, "no agent-host pod is ready", http.StatusServiceUnavailable)
			return
		}
		// Retry only when the primary target is an owner IP rather than the fallback.
		canRetry := target.Host != fallback.Host
		// Tracked so a switch to private can end what a non-owner already holds open.
		r, release := liveConns.track(r, convID, ownerFrom(r))
		defer release()
		if IsAguiPost(r.Method, r.URL.Path) {
			serveAguiLogged(func(ww http.ResponseWriter) {
				serveVia(shutdownCtx, ww, r, target, fallback, canRetry, convID)
			}, w, convID, target, fallback)
			return
		}
		serveVia(shutdownCtx, w, r, target, fallback, canRetry, convID)
	}
	return h
}

// agentHostKeepAlive is agent-host's server keepAliveTimeout (services/agent-host/src/agui/server.ts).
const agentHostKeepAlive = 65 * time.Second

// upstreamTransport pools connections to agent-host and drops idle ones before
// agentHostKeepAlive, so the router never reuses a connection agent-host is closing.
var upstreamTransport = func() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.IdleConnTimeout = 30 * time.Second
	return t
}()

// rewindBody resets r's body for a replay, reporting whether it could.
func rewindBody(r *http.Request) bool {
	if r.Body == nil || r.Body == http.NoBody {
		return true
	}
	if r.GetBody == nil {
		return false
	}
	body, err := r.GetBody()
	if err != nil {
		return false
	}
	r.Body = body
	return true
}

// serveVia reverse-proxies r to `target`, retrying once against `fallback` on a pre-response failure when `retry` is set and the request can be replayed.
func serveVia(shutdownCtx context.Context, w http.ResponseWriter, r *http.Request, target, fallback *url.URL, retry bool, convID string) {
	log := logger("proxy")
	tw := &trackingWriter{ResponseWriter: w}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = upstreamTransport
	proxy.FlushInterval = -1 // flush immediately for SSE
	proxy.ErrorHandler = func(ww http.ResponseWriter, rr *http.Request, e error) {
		kind := classifyProxyError(e, shutdownCtx, rr.Context())
		// An EOF or reset before any response, with the client still here, is the upstream
		// closing on us; treating it as routine would answer an empty 200.
		if kind.routine() && !tw.wrote && rr.Context().Err() == nil {
			kind = proxyErrUpstream
		}
		fields := []any{
			convAttr(convID),
			slog.String("upstream", target.Host),
			slog.String("method", rr.Method),
			slog.String("path", rr.URL.Path),
			slog.String("reason", kind.String()),
			errAttr(e),
		}

		// A routine ending (a reader gone, a finished body) is not an error, and nobody is left to receive a 502.
		if kind.routine() {
			log.Debug("stream ended", fields...)
			return
		}
		if kind == proxyErrShutdown {
			// Expected during a rollout, but still this server dropping somebody's in-flight request.
			log.Warn("request cancelled by shutdown", fields...)
			return
		}

		if retry && !tw.wrote && (isDialFailure(e) || rewindBody(rr)) {
			// The owner IP failed before any bytes flowed, so serve via the fallback with retry=false.
			log.Warn("upstream unreachable, retrying via fallback",
				append(fields, slog.String("fallback", fallback.Host),
					slog.Bool("dial_failure", isDialFailure(e)))...)
			serveVia(shutdownCtx, ww, rr, fallback, fallback, false, convID)
			return
		}
		// A genuine proxy failure with no retry left.
		log.Error("proxy failed",
			append(fields, slog.Bool("response_started", tw.wrote),
				slog.Bool("dial_failure", isDialFailure(e)))...)
		if tw.wrote {
			// Headers already went out, so a 502 now would be a protocol violation.
			return
		}
		http.Error(ww, "upstream unavailable", http.StatusBadGateway)
	}
	proxy.ServeHTTP(tw, r)
}

// trackingWriter records whether any response byte or header has been written, so the dial-fail retry only fires while the client response is untouched.
type trackingWriter struct {
	http.ResponseWriter
	wrote bool
}

func (t *trackingWriter) WriteHeader(code int) { t.wrote = true; t.ResponseWriter.WriteHeader(code) }
func (t *trackingWriter) Write(b []byte) (int, error) {
	t.wrote = true
	return t.ResponseWriter.Write(b)
}

// Flush lets SSE streaming pass through the tracking wrapper.
func (t *trackingWriter) Flush() {
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack lets WebSocket upgrades pass through and marks the response as written, since a hijack takes over the conn.
func (t *trackingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := t.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	t.wrote = true
	return h.Hijack()
}

// ownerResolver maps a conversation to its pod IP.
type ownerResolver interface {
	Resolve(ctx context.Context, id string) (ip, convID string, found bool, err error)
	Assigned(ctx context.Context, id string) bool
}

// readResolver resolves without claiming a Suspended conversation.
type readResolver interface {
	ResolveRead(ctx context.Context, id string) (ip, convID string, found bool, err error)
}

// isPassiveRead reports whether r is a plain read under /conversations/<id>/ that never resumes
// the Sandbox; streams, upgrades and /c/<id>/ web-service traffic (which wakes it) are excluded.
func isPassiveRead(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if isSSE(r) || r.Header.Get("Upgrade") != "" || r.Header.Get(SandboxHostHeader) != "" {
		return false
	}
	parts := splitPath(r.URL.Path)
	return len(parts) >= 2 && parts[0] == "conversations"
}

// resolveTargetFor returns a request's conversation id and upstream.
func resolveTargetFor(cfg config, resolver ownerResolver, r *http.Request, fallback *url.URL) (string, *url.URL, error) {
	if IsNonScoped(r.URL.Path) {
		return "", fallback, nil
	}
	convID := ""
	if IsAguiPost(r.Method, r.URL.Path) {
		convID = aguiThreadID(r) // reads and restores the body
	} else if id, ok := ConvIDFromPath(r.URL.Path); ok {
		convID = id
	}
	if convID == "" || resolver == nil {
		return convID, fallback, nil
	}
	resolve := resolver.Resolve
	if rr, ok := resolver.(readResolver); ok && isPassiveRead(r) {
		resolve = rr.ResolveRead
	}
	ip, resolved, found, err := resolve(r.Context(), convID)
	if err == nil && found && ip == "" {
		// A passive read of a Suspended conversation with no live host.
		return resolved, fallback, nil
	}
	if errors.Is(err, ErrNoPods) {
		return convID, nil, err
	}
	if err != nil {
		// Reads still work; the fence refuses unassigned writes.
		logger("route").Warn("assignment lookup failed, using the Service", convAttr(convID), errAttr(err))
		return convID, fallback, nil
	}
	if !found {
		// No such conversation; let agent-host answer.
		return convID, fallback, nil
	}
	return resolved, TargetURL(ip, cfg.upstreamPort), nil
}

// aguiThreadID reads threadId from the POST /agui JSON body, then restores the body so the proxy forwards it unconsumed.
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
	r.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(buf)), nil }
	r.ContentLength = int64(len(buf))
	var body struct {
		ThreadID string `json:"threadId"`
	}
	_ = json.Unmarshal(buf, &body)
	return body.ThreadID
}

// buildTrustedCaller wires the TokenReview verifier that lets webhooks/scheduler set a conversation `owner` in the create body; every failure path warns and returns nil.
func buildTrustedCaller(kubeCfg *rest.Config, log *slog.Logger) TrustedCaller {
	allowed := trustedServiceAccounts()
	if len(allowed) == 0 {
		log.Warn("WEBHOOKS_SERVICE_ACCOUNT unset: an owner resolved by webhooks/scheduler cannot be honored")
		return nil
	}
	// Both audiences, so callers can move to the router's own.
	audiences := env("WEBHOOKS_TOKEN_AUDIENCE", "agent-host") + "," + env("ROUTER_TOKEN_AUDIENCE", "scooter-router")
	review, err := newTokenReviewer(kubeCfg, audiences)
	if err != nil {
		log.Warn("TokenReview client init failed: webhook-resolved conversation owners will be dropped", errAttr(err))
		return nil
	}
	log.Info("body-owner trust enabled", slog.Int("trusted_service_accounts", len(allowed)))
	return newTrustedCaller(review, allowed)
}

// buildSpawner verifies spawn callers; nil disables spawning.
func buildSpawner(kubeCfg *rest.Config, log *slog.Logger) TrustedCaller {
	allowed := spawnServiceAccounts()
	if len(allowed) == 0 {
		return nil
	}
	audiences := env("WEBHOOKS_TOKEN_AUDIENCE", "agent-host") + "," + env("ROUTER_TOKEN_AUDIENCE", "scooter-router")
	review, err := newTokenReviewer(kubeCfg, audiences)
	if err != nil {
		log.Warn("TokenReview client init failed: conversation spawns are refused", errAttr(err))
		return nil
	}
	log.Info("conversation spawns enabled", slog.Int("spawner_service_accounts", len(allowed)))
	return newTrustedCaller(review, allowed)
}

// buildReader verifies owned-read callers, or returns nil when none are allowed.
func buildReader(kubeCfg *rest.Config, log *slog.Logger) TrustedCaller {
	allowed := readerServiceAccounts()
	if len(allowed) == 0 {
		return nil
	}
	audiences := env("WEBHOOKS_TOKEN_AUDIENCE", "agent-host") + "," + env("ROUTER_TOKEN_AUDIENCE", "scooter-router")
	review, err := newTokenReviewer(kubeCfg, audiences)
	if err != nil {
		log.Warn("TokenReview client init failed: owned reads are refused", errAttr(err))
		return nil
	}
	log.Info("owned reads enabled", slog.Int("reader_service_accounts", len(allowed)))
	return newTrustedCaller(review, allowed)
}

// buildFolderServices verifies folder services; nil when none allowed.
func buildFolderServices(kubeCfg *rest.Config, log *slog.Logger) FolderService {
	allowed := folderServiceAccounts()
	if len(allowed) == 0 {
		return nil
	}
	audiences := env("WEBHOOKS_TOKEN_AUDIENCE", "agent-host") + "," + env("ROUTER_TOKEN_AUDIENCE", "scooter-router")
	review, err := newTokenReviewer(kubeCfg, audiences)
	if err != nil {
		log.Warn("TokenReview client init failed: locked folders can't be changed", errAttr(err))
		return nil
	}
	log.Info("folder services enabled", slog.Int("folder_service_accounts", len(allowed)))
	return newFolderService(review, allowed)
}

// buildSelfServer returns the sandbox self-access listener (see selfaccess.go), or nil when SELF_LISTEN_ADDR is unset or it cannot verify tokens.
func buildSelfServer(kubeCfg *rest.Config, cfg config, store *Store, handler http.Handler, log *slog.Logger) *http.Server {
	addr := cfg.selfListenAddr
	if addr == "" {
		return nil
	}
	if kubeCfg == nil || store == nil {
		log.Warn("SELF_LISTEN_ADDR set but TokenReview or the conversation store is unavailable: self-access disabled")
		return nil
	}
	audience := env("SELF_TOKEN_AUDIENCE", "scooter-self")
	review, err := newTokenReviewer(kubeCfg, audience)
	if err != nil {
		log.Warn("self-access TokenReview client init failed: self-access disabled", errAttr(err))
		return nil
	}
	self := newSelfAccess(review, cfg.namespace, store.ConversationByID, identityConfigFromEnv(), atoi(env("SELF_MESSAGES_PER_MINUTE", "10")))
	log.Info("self-access listener enabled", slog.String("listen_addr", addr), slog.String("audience", audience))
	return &http.Server{Addr: addr, Handler: self.wrap(handler)}
}

// validateListenAddrs fails fast when two enabled listeners share a port; otherwise the
// later bind fails at runtime and exits with a bare "address already in use".
func validateListenAddrs(cfg config) error {
	type listener struct{ env, addr string }
	ls := []listener{{"LISTEN_ADDR", cfg.listenAddr}}
	if cfg.selfListenAddr != "" {
		ls = append(ls, listener{"SELF_LISTEN_ADDR", cfg.selfListenAddr})
	}
	if cfg.sandboxDomain != "" {
		ls = append(ls, listener{"SANDBOX_LISTEN_ADDR", cfg.sandboxListenAddr})
	}
	seen := map[string]string{}
	for _, l := range ls {
		port := l.addr
		if _, p, err := net.SplitHostPort(l.addr); err == nil {
			port = p
		}
		if prev, ok := seen[port]; ok {
			return fmt.Errorf("%s and %s must differ: both use port %s", prev, l.env, port)
		}
		seen[port] = l.env
	}
	return nil
}

// --- k8s client + unstructured helpers (used by cache.go) -------------------

// kubeRestConfig resolves the apiserver credentials shared by the dynamic client and the TokenReview verifier.
func kubeRestConfig() (*rest.Config, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return clientcmd.BuildConfigFromFlags("", clientcmd.RecommendedHomeFile)
	}
	return cfg, nil
}

func newDynamicClient() (dynamic.Interface, *rest.Config, error) {
	cfg, err := kubeRestConfig()
	if err != nil {
		return nil, nil, err
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, nil, err
	}
	return dyn, cfg, nil
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

// isSSE reports whether the caller asked for the event stream rather than the JSON list.
func isSSE(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream") ||
		strings.HasSuffix(r.URL.Path, "/events")
}
