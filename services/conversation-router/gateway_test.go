package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/chadac-me/scooter/conversation-router/svcauth"
)

const (
	gwNS       = "agent-sandbox"
	gwBroker   = "system:serviceaccount:" + gwNS + ":agent-broker"
	gwWebhooks = "system:serviceaccount:" + gwNS + ":agent-webhooks"
)

// authProxy fakes oauth2-proxy's /oauth2/auth: cookie value "alice" is alice's session.
func authProxy(t *testing.T, status *int, calls *int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(calls, 1)
		if *status != 0 {
			w.WriteHeader(*status)
			return
		}
		c, err := r.Cookie("_oauth2_proxy")
		if err != nil || c.Value == "" || c.Value == "expired" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if strings.Contains(r.Header.Get("Cookie"), "theme") {
			t.Errorf("non-session cookie forwarded: %q", r.Header.Get("Cookie"))
		}
		w.Header().Set("X-Auth-Request-User", c.Value)
		w.Header().Set("X-Auth-Request-Email", c.Value+"@example.com")
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func browserReq(session string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/conversations/abc", nil)
	r.AddCookie(&http.Cookie{Name: "theme", Value: "dark"})
	if session != "" {
		r.AddCookie(&http.Cookie{Name: "_oauth2_proxy", Value: session})
	}
	return r
}

func TestSessionCheckerCachesDefiniteVerdictsOnly(t *testing.T) {
	status, calls := 0, int32(0)
	s := newSessionChecker(authProxy(t, &status, &calls).URL, []string{"_oauth2_proxy"})
	ctx := context.Background()

	user, email, err := s.check(ctx, browserReq("alice"))
	if err != nil || user != "alice" || email != "alice@example.com" {
		t.Fatalf("got %q %q %v", user, email, err)
	}
	// A different non-session cookie still hits the cache.
	r := browserReq("alice")
	r.AddCookie(&http.Cookie{Name: "theme2", Value: "x"})
	if _, _, err := s.check(ctx, r); err != nil || calls != 1 {
		t.Fatalf("cached check: err=%v calls=%d", err, calls)
	}
	if _, _, err := s.check(ctx, browserReq("expired")); !errors.Is(err, errSessionInvalid) {
		t.Fatalf("expired session: %v", err)
	}
	if _, _, err := s.check(ctx, browserReq("expired")); !errors.Is(err, errSessionInvalid) || calls != 2 {
		t.Fatalf("rejection not cached: err=%v calls=%d", err, calls)
	}
	if _, _, err := s.check(ctx, browserReq("")); !errors.Is(err, errNoSession) || calls != 2 {
		t.Fatalf("no cookie: err=%v calls=%d", err, calls)
	}

	status = http.StatusBadGateway
	if _, _, err := s.check(ctx, browserReq("bob")); err == nil || errors.Is(err, errSessionInvalid) {
		t.Fatalf("outage should be an error: %v", err)
	}
	status = 0
	if user, _, err := s.check(ctx, browserReq("bob")); err != nil || user != "bob" {
		t.Fatalf("outage was cached: %q %v", user, err)
	}

	s.now = func() time.Time { return time.Now().Add(sessionCacheTTL + time.Second) }
	before := calls
	if _, _, err := s.check(ctx, browserReq("alice")); err != nil || calls != before+1 {
		t.Fatalf("expired cache entry not re-checked: err=%v calls=%d", err, calls)
	}
}

func TestSessionCheckerNeedsANamedUser(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	s := newSessionChecker(srv.URL, []string{"_oauth2_proxy"})
	if _, _, err := s.check(context.Background(), browserReq("alice")); err == nil || errors.Is(err, errSessionInvalid) {
		t.Fatalf("a 202 naming no user must be a config error, got %v", err)
	}
}

// albToken signs claims the way ALB does, padded segments included.
func albToken(t *testing.T, key *ecdsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.URLEncoding.EncodeToString(b)
	}
	head := enc(map[string]any{"alg": "ES256", "kid": kid})
	body := enc(claims)
	digest := sha256.Sum256([]byte(head + "." + body))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return head + "." + body + "." + base64.URLEncoding.EncodeToString(sig)
}

func testAlb(t *testing.T) (*albVerifier, *ecdsa.PrivateKey) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	v := newAlbVerifier("us-east-1")
	v.fetch = func(_ context.Context, kid string) ([]byte, error) {
		if kid != "k1" {
			return nil, errors.New("unreachable")
		}
		return pemKey, nil
	}
	return v, key
}

func TestAlbVerify(t *testing.T) {
	v, key := testAlb(t)
	ctx := context.Background()
	exp := time.Now().Add(time.Minute).Unix()

	sub, email, err := v.verify(ctx, albToken(t, key, "k1", map[string]any{"sub": "u-1", "email": "a@x", "exp": exp}))
	if err != nil || sub != "u-1" || email != "a@x" {
		t.Fatalf("valid token: %q %q %v", sub, email, err)
	}

	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if _, _, err := v.verify(ctx, albToken(t, other, "k1", map[string]any{"sub": "u-1", "exp": exp})); !errors.Is(err, errAlbInvalid) {
		t.Fatalf("foreign signature: %v", err)
	}
	old := time.Now().Add(-time.Hour).Unix()
	if _, _, err := v.verify(ctx, albToken(t, key, "k1", map[string]any{"sub": "u-1", "exp": old})); !errors.Is(err, errAlbInvalid) {
		t.Fatalf("expired: %v", err)
	}
	if _, _, err := v.verify(ctx, "not.a-jwt"); !errors.Is(err, errAlbInvalid) {
		t.Fatalf("garbage: %v", err)
	}
	// An unreachable key endpoint is an outage, not a forgery.
	if _, _, err := v.verify(ctx, albToken(t, key, "k2", map[string]any{"sub": "u-1", "exp": exp})); err == nil || errors.Is(err, errAlbInvalid) {
		t.Fatalf("key fetch failure: %v", err)
	}
}

// fakeReview authenticates token "<aud>:<username>" for that audience only.
func fakeReview(aud string) svcauth.ReviewFunc {
	return func(_ context.Context, token string) (string, bool, error) {
		if token == "down" {
			return "", false, errors.New("apiserver unreachable")
		}
		a, user, ok := strings.Cut(token, ":")
		if !ok || a != aud {
			return "", false, nil
		}
		return user, true, nil
	}
}

type logged struct{ buf bytes.Buffer }

func (l *logged) lines(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(l.buf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func testGateway(t *testing.T, checkURL string) (*gateway, *logged) {
	t.Helper()
	l := &logged{}
	g := newGateway("main", identityConfig{mode: "header", userHeader: "x-auth-user"})
	g.log = slog.New(slog.NewJSONHandler(&l.buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	g.spawn = func(f func()) { f() }
	g.prefixes = []string{"_oauth2_proxy"}
	if checkURL != "" {
		g.session = newSessionChecker(checkURL, g.prefixes)
	}
	g.services = svcauth.NewVerifier(fakeReview("scooter-router"))
	g.legacy = svcauth.NewVerifier(fakeReview("agent-host"))
	g.policy = svcauth.Policy{
		Services:  map[string]bool{gwBroker: true},
		Asserters: map[string]bool{gwWebhooks: true},
	}
	g.public = healthPaths
	return g, l
}

func TestGatewayAuthenticate(t *testing.T) {
	status, calls := 0, int32(0)
	g, _ := testGateway(t, authProxy(t, &status, &calls).URL)
	ctx := context.Background()
	bearer := func(token string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/conversations/abc/links", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		return r
	}

	cases := []struct {
		name    string
		req     *http.Request
		kind    string
		user    string
		legacy  bool
		status  int
		wantErr bool
	}{
		{name: "browser session", req: browserReq("alice"), kind: "user", user: "alice"},
		{name: "dead session", req: browserReq("expired"), wantErr: true, status: 401},
		{name: "service token", req: bearer("scooter-router:" + gwBroker), kind: "service"},
		{name: "legacy audience", req: bearer("agent-host:" + gwBroker), kind: "service", legacy: true},
		{name: "foreign audience", req: bearer("agent-broker:" + gwBroker), wantErr: true, status: 401},
		{name: "SA not allowed", req: bearer("scooter-router:system:serviceaccount:" + gwNS + ":sandbox-x"), wantErr: true, status: 403},
		{name: "review outage", req: bearer("down"), wantErr: true, status: 503},
		{name: "nothing", req: httptest.NewRequest(http.MethodGet, "/conversations", nil), wantErr: true, status: 401},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, err := g.authenticate(ctx, c.req)
			if c.wantErr {
				if err == nil {
					t.Fatalf("want an error, got %+v", p)
				}
				if got := gatewayStatus(err); got != c.status {
					t.Fatalf("status %d, want %d (%v)", got, c.status, err)
				}
				return
			}
			if err != nil || p.kind != c.kind || p.user != c.user || p.legacyAudience != c.legacy {
				t.Fatalf("got %+v, %v", p, err)
			}
		})
	}

	// An asserter names the user; a plain service cannot.
	r := bearer("scooter-router:" + gwWebhooks)
	r.Header.Set(svcauth.UserHeader, "carol")
	if p, err := g.authenticate(ctx, r); err != nil || p.user != "carol" {
		t.Fatalf("asserter: %+v %v", p, err)
	}
	r = bearer("scooter-router:" + gwBroker)
	r.Header.Set(svcauth.UserHeader, "carol")
	if p, err := g.authenticate(ctx, r); err != nil || p.user != "" {
		t.Fatalf("non-asserter named a user: %+v %v", p, err)
	}

	// A browser's app-level Authorization is ignored for its session.
	r = browserReq("alice")
	r.Header.Set("Authorization", "Bearer app-secret")
	if p, err := g.authenticate(ctx, r); err != nil || p.user != "alice" {
		t.Fatalf("browser with app bearer: %+v %v", p, err)
	}
}

func TestGatewayWithoutBrowserProofOnlyJudgesTokens(t *testing.T) {
	g, l := testGateway(t, "")
	h := g.wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	r := browserReq("alice")
	r.Header.Set("x-auth-user", "alice")
	h.ServeHTTP(httptest.NewRecorder(), r)
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/conversations", nil))
	if lines := l.lines(t); len(lines) != 0 {
		t.Fatalf("unverifiable requests must not be logged: %v", lines)
	}
}

func TestGatewayShadowServesAndLogs(t *testing.T) {
	status, calls := 0, int32(0)
	g, l := testGateway(t, authProxy(t, &status, &calls).URL)
	served := 0
	h := g.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served++
		// Handler header edits must not reach the background check.
		r.Header.Del("x-auth-user")
		w.WriteHeader(http.StatusNoContent)
	}))

	forged := browserReq("alice")
	forged.Header.Set("x-auth-user", "mallory")
	unauthenticated := httptest.NewRequest(http.MethodGet, "/conversations", nil)
	health := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	for _, r := range []*http.Request{forged, unauthenticated, health} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("shadow mode refused %s: %d", r.URL.Path, rec.Code)
		}
	}
	if served != 3 {
		t.Fatalf("served %d of 3", served)
	}

	var msgs []string
	for _, m := range l.lines(t) {
		msgs = append(msgs, m["msg"].(string))
		switch m["msg"] {
		case "auth identity mismatch":
			if m["claimed_user"] != "mallory" || m["user"] != "alice" || m["has_cookie"] != true {
				t.Fatalf("mismatch fields: %v", m)
			}
		case "auth would reject":
			if m["status"] != float64(401) || m["path"] != "/conversations" ||
				m["remote_addr"] != "192.0.2.1:1234" || m["has_cookie"] != false || m["has_authorization"] != false {
				t.Fatalf("reject fields: %v", m)
			}
		}
	}
	if strings.Join(msgs, ",") != "auth identity mismatch,auth would reject" {
		t.Fatalf("logged %v", msgs)
	}
	// Credentials are flagged as present, never logged.
	if strings.Contains(l.buf.String(), "dark") {
		t.Fatalf("cookie value leaked into the log: %s", l.buf.String())
	}
}

func TestGatewayLogsLegacyAudienceOncePerCaller(t *testing.T) {
	g, l := testGateway(t, "")
	h := g.wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	for range 3 {
		r := httptest.NewRequest(http.MethodPost, "/conversations", nil)
		r.Header.Set("Authorization", "Bearer agent-host:"+gwWebhooks)
		h.ServeHTTP(httptest.NewRecorder(), r)
	}
	n := 0
	for _, m := range l.lines(t) {
		if m["msg"] == "caller uses the legacy agent-host token audience" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("legacy notice logged %d times", n)
	}
}

func TestSandboxGatewayIgnoresAuthorization(t *testing.T) {
	status, calls := 0, int32(0)
	g, _ := testGateway(t, authProxy(t, &status, &calls).URL)
	g.services, g.legacy = nil, nil
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer scooter-router:"+gwBroker)
	if _, err := g.authenticate(context.Background(), r); !errors.Is(err, errNoCredentials) {
		t.Fatalf("a sandbox host must need a session, got %v", err)
	}
}

func TestGatewayEnforceRefusesAndRestamps(t *testing.T) {
	status, calls := 0, int32(0)
	g, l := testGateway(t, authProxy(t, &status, &calls).URL)
	g.enforce, g.legacy = true, nil
	g.identity.emailHeader = "x-auth-email"
	var seenUser, seenEmail string
	served := 0
	h := g.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served++
		seenUser, seenEmail = r.Header.Get("x-auth-user"), r.Header.Get("x-auth-email")
		w.WriteHeader(http.StatusNoContent)
	}))
	serve := func(r *http.Request) int {
		seenUser, seenEmail = "unset", "unset"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec.Code
	}
	bearer := func(token string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/conversations", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		return r
	}

	// A forged header is replaced by the session's user.
	forged := browserReq("alice")
	forged.Header.Set("x-auth-user", "mallory")
	forged.Header.Set("x-auth-email", "mallory@example.com")
	if code := serve(forged); code != http.StatusNoContent || seenUser != "alice" || seenEmail != "alice@example.com" {
		t.Fatalf("forged header: %d %q %q", code, seenUser, seenEmail)
	}

	// An asserter's named user becomes the identity.
	r := bearer("scooter-router:" + gwWebhooks)
	r.Header.Set(svcauth.UserHeader, "carol")
	if code := serve(r); code != http.StatusNoContent || seenUser != "carol" {
		t.Fatalf("asserter: %d %q", code, seenUser)
	}

	// A plain service cannot claim a user through the identity header.
	r = bearer("scooter-router:" + gwBroker)
	r.Header.Set("x-auth-user", "mallory")
	if code := serve(r); code != http.StatusNoContent || seenUser != "" || seenEmail != "" {
		t.Fatalf("service: %d %q %q", code, seenUser, seenEmail)
	}

	refused := []struct {
		name   string
		req    *http.Request
		status int
	}{
		{"header only", func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/whoami", nil)
			r.Header.Set("x-auth-user", "mallory")
			return r
		}(), 401},
		{"dead session", browserReq("expired"), 401},
		{"legacy audience", bearer("agent-host:" + gwWebhooks), 401},
		{"SA not allowed", bearer("scooter-router:system:serviceaccount:" + gwNS + ":sandbox-x"), 403},
	}
	for _, c := range refused {
		before := served
		if code := serve(c.req); code != c.status || served != before {
			t.Fatalf("%s: got %d (served %v), want %d", c.name, code, served != before, c.status)
		}
	}
	if code := serve(httptest.NewRequest(http.MethodGet, "/healthz", nil)); code != http.StatusNoContent {
		t.Fatalf("health probe refused: %d", code)
	}

	rejected := 0
	for _, m := range l.lines(t) {
		if m["msg"] == "auth would reject" {
			t.Fatalf("enforcing gateway logged shadow wording: %v", m)
		}
		if m["msg"] == "auth rejected" {
			rejected++
		}
	}
	if rejected != len(refused) {
		t.Fatalf("logged %d rejections, want %d", rejected, len(refused))
	}
}

func TestGatewayEnforceWithoutBrowserProofFailsClosed(t *testing.T) {
	g, l := testGateway(t, "")
	g.enforce = true
	h := g.wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("served a browser request nothing could verify")
	}))
	r := browserReq("alice")
	r.Header.Set("x-auth-user", "alice")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code < 400 {
		t.Fatalf("got %d", rec.Code)
	}
	if len(l.lines(t)) != 1 {
		t.Fatalf("refusal not logged: %s", l.buf.String())
	}
}
