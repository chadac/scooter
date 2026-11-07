package main

// Identity gateway: proves each caller; shadow mode only logs refusals.

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/chadac-me/scooter/conversation-router/svcauth"
)

const (
	// shadowTimeout bounds one background check.
	shadowTimeout = 10 * time.Second
	// shadowMaxInFlight caps background checks; past it, checks are skipped.
	shadowMaxInFlight = 256
)

var (
	errNoCredentials = errors.New("no session or service token")
	// errUnverifiable: no browser proof configured, so nothing is judged.
	errUnverifiable = errors.New("browser identity not verifiable")
)

// gatewayPrincipal is who a request was proven to come from.
type gatewayPrincipal struct {
	kind           string // "user" or "service"
	via            string // "session", "alb" or "token"
	user, email    string
	serviceAccount string
	legacyAudience bool
}

type gateway struct {
	listener string // "main" or "sandbox", for logs
	// enforce refuses unproven callers and restamps identity headers.
	enforce  bool
	identity identityConfig
	prefixes []string
	session  *sessionChecker // nil: no session proof
	alb      *albVerifier    // nil: no ALB proof
	// services verifies bearers; nil ignores Authorization, which sandbox apps use.
	services *svcauth.Verifier
	// legacy accepts the `agent-host` audience until callers migrate.
	legacy *svcauth.Verifier
	policy svcauth.Policy
	// assertions mints user assertions; nil mints none.
	assertions *assertionMinter
	public     func(*http.Request) bool
	log        *slog.Logger
	// spawn runs a background check; tests run it inline.
	spawn func(func())

	inFlight   chan struct{}
	legacySeen sync.Map
}

func newGateway(listener string, identity identityConfig) *gateway {
	return &gateway{
		listener: listener,
		identity: identity,
		public:   func(*http.Request) bool { return false },
		log:      logger("gateway"),
		spawn:    func(f func()) { go f() },
		inFlight: make(chan struct{}, shadowMaxInFlight),
	}
}

func (g *gateway) browserProof() bool {
	if g.identity.mode == "alb-oidc" {
		return g.alb != nil
	}
	return g.session != nil
}

// fromBrowser reports whether r carries the ingress's browser credential.
func (g *gateway) fromBrowser(r *http.Request) bool {
	if g.identity.mode == "alb-oidc" {
		return strings.TrimSpace(r.Header.Get(g.identity.albDataHeader)) != ""
	}
	return sessionCookies(r, g.prefixes) != ""
}

// authenticate proves the caller; browser credentials beat bearer tokens.
func (g *gateway) authenticate(ctx context.Context, r *http.Request) (gatewayPrincipal, error) {
	hasBearer := g.services != nil && svcauth.BearerToken(r) != ""
	if g.fromBrowser(r) || (!hasBearer && !g.browserProof()) {
		return g.authenticateBrowser(ctx, r)
	}
	if !hasBearer {
		return gatewayPrincipal{}, errNoCredentials
	}
	p, err := g.services.Resolve(ctx, r, g.policy)
	legacy := false
	if errors.Is(err, svcauth.ErrUnauthenticated) && g.legacy != nil {
		if lp, lerr := g.legacy.Resolve(ctx, r, g.policy); lerr == nil || !errors.Is(lerr, svcauth.ErrUnauthenticated) {
			p, err, legacy = lp, lerr, lerr == nil
		}
	}
	out := gatewayPrincipal{kind: "service", via: "token", serviceAccount: p.ServiceAccount,
		user: p.User, email: p.Email, legacyAudience: legacy}
	return out, err
}

func (g *gateway) authenticateBrowser(ctx context.Context, r *http.Request) (gatewayPrincipal, error) {
	if !g.browserProof() {
		return gatewayPrincipal{}, errUnverifiable
	}
	if g.identity.mode == "alb-oidc" {
		sub, email, err := g.alb.verify(ctx, strings.TrimSpace(r.Header.Get(g.identity.albDataHeader)))
		return gatewayPrincipal{kind: "user", via: "alb", user: sub, email: email}, err
	}
	user, email, err := g.session.check(ctx, r)
	return gatewayPrincipal{kind: "user", via: "session", user: user, email: email}, err
}

// gatewayStatus is the status enforcement would answer with.
func gatewayStatus(err error) int {
	switch {
	case errors.Is(err, errNoCredentials), errors.Is(err, errNoSession),
		errors.Is(err, errSessionInvalid), errors.Is(err, errAlbInvalid):
		return http.StatusUnauthorized
	default:
		return svcauth.Status(err)
	}
}

// wrap checks non-public requests: inline when enforcing, else in the background.
func (g *gateway) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Del(userAssertionHeader) // only stamp may set one
		switch {
		case g.public(r):
		case g.enforce:
			p, err := g.authenticate(r.Context(), r)
			g.observe(r, p, err)
			if err != nil {
				status := gatewayStatus(err)
				writeJSONError(w, status, strings.ToLower(http.StatusText(status)))
				return
			}
			g.stamp(r, p)
		default:
			g.shadow(r)
		}
		next.ServeHTTP(w, r)
	})
}

// stamp replaces client-sent identity headers with the proven caller's.
func (g *gateway) stamp(r *http.Request, p gatewayPrincipal) {
	header := g.identity.identityHeader()
	r.Header.Del(header)
	if g.identity.mode != "alb-oidc" {
		r.Header.Del(g.identity.emailHeader)
	}
	if p.user == "" {
		return
	}
	g.assertions.stamp(r, p)
	r.Header.Set(header, p.user)
	if p.email != "" && g.identity.mode != "alb-oidc" {
		r.Header.Set(g.identity.emailHeader, p.email)
	}
}

// shadow checks a snapshot, since handlers mutate r's headers.
func (g *gateway) shadow(r *http.Request) {
	select {
	case g.inFlight <- struct{}{}:
	default:
		g.log.Debug("auth check skipped: too many in flight", slog.String("listener", g.listener))
		return
	}
	snap := r.Clone(context.WithoutCancel(r.Context()))
	snap.Body = http.NoBody
	g.spawn(func() {
		defer func() { <-g.inFlight }()
		ctx, cancel := context.WithTimeout(snap.Context(), shadowTimeout)
		defer cancel()
		p, err := g.authenticate(ctx, snap)
		g.observe(snap, p, err)
	})
}

func (g *gateway) observe(r *http.Request, p gatewayPrincipal, err error) {
	claimed := g.identity.owner(r)
	fields := []any{
		slog.String("listener", g.listener),
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
	}
	if claimed != "" {
		fields = append(fields, slog.String("claimed_user", claimed))
	}
	if p.serviceAccount != "" {
		fields = append(fields, slog.String("service_account", p.serviceAccount))
	}
	reject := "auth would reject"
	if g.enforce {
		reject = "auth rejected"
	}
	switch {
	case errors.Is(err, errUnverifiable) && !g.enforce:
		return
	case err != nil:
		g.log.Warn(reject, append(append(fields, callerFields(r)...),
			slog.Int("status", gatewayStatus(err)), slog.String("reason", err.Error()))...)
		return
	}
	fields = append(fields, slog.String("principal", p.kind), slog.String("via", p.via))
	if p.user != "" {
		fields = append(fields, slog.String("user", p.user))
	}
	// A header naming someone else is forgery or misconfiguration.
	if claimed != "" && claimed != p.user {
		g.log.Warn("auth identity mismatch", append(append(fields, callerFields(r)...),
			slog.String("reason", "identity header does not match the proven caller"))...)
		return
	}
	if p.legacyAudience {
		if _, seen := g.legacySeen.LoadOrStore(p.serviceAccount, true); !seen {
			g.log.Info("caller uses the legacy agent-host token audience", fields...)
		}
	}
	g.log.Debug("auth ok", fields...)
}

// healthPaths are credential-less kubelet and Prometheus probes.
func healthPaths(r *http.Request) bool {
	parts := splitPath(r.URL.Path)
	if len(parts) != 1 {
		return false
	}
	switch parts[0] {
	case "healthz", "health", "metrics":
		return true
	}
	return false
}

// callerFields identify a refused caller without logging its credentials.
func callerFields(r *http.Request) []any {
	return []any{
		slog.String("remote_addr", r.RemoteAddr),
		slog.String("forwarded_for", r.Header.Get("X-Forwarded-For")),
		slog.String("user_agent", r.UserAgent()),
		slog.Bool("has_cookie", r.Header.Get("Cookie") != ""),
		slog.Bool("has_authorization", r.Header.Get("Authorization") != ""),
	}
}
