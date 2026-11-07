package main

// Self-access: a sandbox pod calling its OWN conversation's API (e.g. VS Code in the sandbox
// continuing the conversation), authenticated by the pod's projected ServiceAccount token.
// Served on a separate listener so the main one keeps trusting ingress identity headers while
// this one never does: a NetworkPolicy can admit sandbox pods to this port alone.

import (
	"context"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/chadac-me/scooter/conversation-router/svcauth"
)

// selfRoutes is the whole surface a sandbox may reach; anything else is 404. Tool-permission
// answers are deliberately absent: anything in the pod holds the token, so it must not be able
// to approve its own requests.
var selfRoutes = []struct {
	method string
	re     *regexp.Regexp
}{
	{http.MethodGet, regexp.MustCompile(`^/conversations/([^/]+)/events$`)},
	// The replay+live stream; /events alone replays and never carries live events to a viewer.
	{http.MethodGet, regexp.MustCompile(`^/conversations/([^/]+)/events\.integrity$`)},
	{http.MethodGet, regexp.MustCompile(`^/conversations/([^/]+)/history$`)},
	{http.MethodPost, regexp.MustCompile(`^/conversations/([^/]+)/messages$`)},
	{http.MethodPost, regexp.MustCompile(`^/conversations/([^/]+)/cancel$`)},
}

// selfRoute returns the conversation id an allowed self-access request targets.
func selfRoute(method, path string) (convID string, isMessage, ok bool) {
	for _, r := range selfRoutes {
		if r.method != method {
			continue
		}
		if m := r.re.FindStringSubmatch(path); m != nil {
			return m[1], strings.HasSuffix(path, "/messages"), true
		}
	}
	return "", false, false
}

// sandboxIDFromUsername matches `sandbox-<id>` only within namespace.
func sandboxIDFromUsername(username, namespace string) (string, bool) {
	return svcauth.SandboxID(username, namespace)
}

// conversationLookup reads the row a self-access request targets; (nil, nil) means no such conversation.
type conversationLookup func(ctx context.Context, id string) (*ConversationRow, error)

type selfAccess struct {
	verifier  *svcauth.Verifier
	namespace string
	lookup    conversationLookup
	// Identity headers stripped from every request: the agent-host must never see a pod-chosen user.
	stripHeaders []string
	// The headers the router sets to the conversation's owner once the pod is proven to be that
	// conversation's sandbox: it acts for its owner, so a private conversation admits it.
	ownerHeaders []string
	// Per-conversation cap on POST /messages, so the agent cannot drive itself in a tight loop.
	messagesPerMinute int
	now               func() time.Time

	mu   sync.Mutex
	sent map[string][]time.Time // conversation id -> recent message times
}

// selfReviewTTL bounds how long a TokenReview verdict is reused.
const selfReviewTTL = svcauth.CacheTTL

func newSelfAccess(review reviewTokenFunc, namespace string, lookup conversationLookup, identity identityConfig, messagesPerMinute int) *selfAccess {
	strip := []string{identity.userHeader, identity.albIdentityHeader, "x-auth-email", "x-amzn-oidc-data", "x-amzn-oidc-accesstoken", userAssertionHeader}
	s := &selfAccess{
		verifier: svcauth.NewVerifier(review), namespace: namespace, lookup: lookup,
		stripHeaders: strip, messagesPerMinute: messagesPerMinute, now: time.Now,
		ownerHeaders: []string{identity.userHeader, identity.albIdentityHeader},
		sent:         map[string][]time.Time{},
	}
	s.verifier.Now = func() time.Time { return s.now() }
	return s
}

// wrap admits a request to `next` only if it is an allowed route on a conversation owned by the calling sandbox.
func (s *selfAccess) wrap(next http.Handler) http.Handler {
	log := logger("self-access")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, h := range s.stripHeaders {
			r.Header.Del(h)
		}
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			return
		}
		convID, isMessage, ok := selfRoute(r.Method, r.URL.Path)
		if !ok {
			http.Error(w, "not available to sandboxes", http.StatusNotFound)
			return
		}
		token := bearerToken(r)
		if token == "" {
			http.Error(w, "bearer token required", http.StatusUnauthorized)
			return
		}
		username, authed, err := s.verifier.Verify(r.Context(), token)
		if err != nil {
			log.Warn("TokenReview failed", errAttr(err))
			http.Error(w, "token verification unavailable", http.StatusServiceUnavailable)
			return
		}
		sandboxID, isSandbox := sandboxIDFromUsername(username, s.namespace)
		if !authed || !isSandbox {
			log.Warn("rejected self-access token", slog.String("username", username), slog.Bool("authenticated", authed))
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		row, err := s.lookup(r.Context(), convID)
		if err != nil {
			log.Warn("conversation lookup failed", convAttr(convID), errAttr(err))
			http.Error(w, "conversation lookup unavailable", http.StatusServiceUnavailable)
			return
		}
		// The row's sandbox_ref names the pod that serves it (subagents share their parent's), so a pod reaches exactly the conversations it runs.
		if row == nil || row.SandboxRef == nil || *row.SandboxRef != "conv-"+sandboxID {
			log.Warn("sandbox does not own conversation", convAttr(convID), slog.String("sandbox", sandboxID))
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if isMessage && !s.allowMessage(convID) {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "too many messages from the sandbox", http.StatusTooManyRequests)
			return
		}
		r.Header.Del("authorization") // the pod's token is for this router only
		if row.Owner != nil {
			for _, h := range s.ownerHeaders {
				r.Header.Set(h, *row.Owner)
			}
		}
		r.Header.Set("x-scooter-caller", "sandbox")
		next.ServeHTTP(w, r)
	})
}

func (s *selfAccess) allowMessage(convID string) bool {
	if s.messagesPerMinute <= 0 {
		return true
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	recent := s.sent[convID][:0]
	for _, t := range s.sent[convID] {
		if now.Sub(t) < time.Minute {
			recent = append(recent, t)
		}
	}
	if len(recent) >= s.messagesPerMinute {
		s.sent[convID] = recent
		return false
	}
	s.sent[convID] = append(recent, now)
	if len(s.sent) > 4096 { // bounded: forget conversations idle for a minute
		for id, ts := range s.sent {
			if len(ts) == 0 || now.Sub(ts[len(ts)-1]) >= time.Minute {
				delete(s.sent, id)
			}
		}
	}
	return true
}
