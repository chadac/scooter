package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"os"
	"strings"
	"syscall"
	"testing"
)

// captureJSON installs a JSON logger writing into a buffer, and returns the decoded lines.
func captureJSON(t *testing.T, fn func()) []map[string]any {
	t.Helper()
	t.Setenv("LOG_FORMAT", "json")
	t.Setenv("LOG_LEVEL", "debug")

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(newHandler(&buf)).With(slog.String("service", serviceName)))
	defer slog.SetDefault(prev)

	fn()

	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line is not JSON: %q (%v)", line, err)
		}
		out = append(out, m)
	}
	return out
}

// The envelope is the contract every cross-service query depends on.
func TestLogEnvelope(t *testing.T) {
	lines := captureJSON(t, func() {
		logger("cache").Info("seeded", convAttr("conv-1"), slog.Int("conversations", 3))
	})
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(lines))
	}
	l := lines[0]
	for k, want := range map[string]string{
		"service":         serviceName,
		"component":       "cache",
		"msg":             "seeded",
		"level":           "info",
		"conversation_id": "conv-1",
	} {
		if got, _ := l[k].(string); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if _, ok := l["ts"]; !ok {
		t.Error("missing ts")
	}
	// msg must be the CONSTANT — values live in fields, so the line stays groupable.
	if !strings.Contains(fmt.Sprint(l["conversations"]), "3") {
		t.Errorf("conversations field missing: %v", l)
	}
}

// An empty id must be OMITTED, not logged as "", or a conversation_id!="" query breaks.
func TestConvAttrOmitsEmpty(t *testing.T) {
	lines := captureJSON(t, func() { logger("proxy").Info("x", convAttr("")) })
	if _, present := lines[0]["conversation_id"]; present {
		t.Errorf("empty id must be omitted, got %v", lines[0]["conversation_id"])
	}
}

// A syscall errno is the discriminator for an unreachable pod and must survive wrapping.
func TestErrAttrCapturesErrno(t *testing.T) {
	wrapped := fmt.Errorf("dial tcp 10.42.0.2:8080: %w",
		&net.OpError{Op: "dial", Err: syscall.ECONNREFUSED})
	lines := captureJSON(t, func() { logger("proxy").Error("proxy failed", errAttr(wrapped)) })

	e, ok := lines[0]["error"].(map[string]any)
	if !ok {
		t.Fatalf("error must be a group, got %T", lines[0]["error"])
	}
	if got, _ := e["errno"].(string); !strings.Contains(got, "refused") {
		t.Errorf("errno = %q, want connection refused", got)
	}
	if got, _ := e["message"].(string); got == "" {
		t.Error("error.message empty")
	}
}

func TestErrAttrTypesContextErrors(t *testing.T) {
	lines := captureJSON(t, func() {
		logger("proxy").Error("a", errAttr(fmt.Errorf("wrapped: %w", context.Canceled)))
		logger("proxy").Error("b", errAttr(fmt.Errorf("wrapped: %w", io.EOF)))
	})
	for i, want := range []string{"context.Canceled", "io.EOF"} {
		e := lines[i]["error"].(map[string]any)
		if got, _ := e["type"].(string); got != want {
			t.Errorf("line %d type = %q, want %q", i, got, want)
		}
	}
}

func TestLogLevelHonored(t *testing.T) {
	t.Setenv("LOG_FORMAT", "json")
	t.Setenv("LOG_LEVEL", "warn")
	var buf bytes.Buffer
	log := slog.New(newHandler(&buf))
	log.Info("suppressed")
	log.Debug("suppressed")
	log.Warn("kept")
	out := buf.String()
	if strings.Contains(out, "suppressed") {
		t.Errorf("LOG_LEVEL=warn must drop info/debug: %q", out)
	}
	if !strings.Contains(out, "kept") {
		t.Errorf("warn must pass: %q", out)
	}
}

// JSON in a pod, text at a terminal.
func TestFormatDefaultsToJSONInCluster(t *testing.T) {
	os.Unsetenv("LOG_FORMAT")
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	if !jsonOutput() {
		t.Error("in-cluster default must be JSON")
	}
	os.Unsetenv("KUBERNETES_SERVICE_HOST")
	if jsonOutput() {
		t.Error("outside a cluster default must be text")
	}
}

// --- the false-error bug -------------------------------------------------------

func TestClassifyProxyError(t *testing.T) {
	live := context.Background()
	cancelled := func() context.Context {
		c, cancel := context.WithCancel(context.Background())
		cancel()
		return c
	}

	cases := []struct {
		name              string
		err               error
		shutdown, req     context.Context
		want              proxyErrorKind
		wantRoutineNotErr bool
	}{
		{"client navigated away from SSE", context.Canceled, live, cancelled(), proxyErrClientGone, true},
		{"wrapped client cancel", fmt.Errorf("proxy: %w", context.Canceled), live, cancelled(), proxyErrClientGone, true},
		{"stream body finished", io.EOF, live, live, proxyErrStreamDone, true},
		{"unexpected EOF mid-body", io.ErrUnexpectedEOF, live, live, proxyErrStreamDone, true},
		{"client reset the connection", syscall.ECONNRESET, live, live, proxyErrClientGone, true},
		{"broken pipe writing to client", syscall.EPIPE, live, live, proxyErrClientGone, true},

		// The subtlety: shutdown is NOT a client disconnect, even though both contexts are done.
		{"server shutting down", context.Canceled, cancelled(), cancelled(), proxyErrShutdown, false},

		// Genuine failures keep their error level.
		{"upstream refused the connection", &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, live, live, proxyErrUpstream, false},
		{"upstream unreachable", syscall.EHOSTUNREACH, live, live, proxyErrUpstream, false},
		{"upstream too slow", context.DeadlineExceeded, live, live, proxyErrUpstream, false},
		{"unknown failure", errors.New("boom"), live, live, proxyErrUpstream, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyProxyError(tc.err, tc.shutdown, tc.req)
			if got != tc.want {
				t.Errorf("kind = %v (%s), want %v (%s)", got, got, tc.want, tc.want)
			}
			if got.routine() != tc.wantRoutineNotErr {
				t.Errorf("routine() = %v, want %v", got.routine(), tc.wantRoutineNotErr)
			}
		})
	}
}

// The regression this fixes: a client leaving an SSE stream must NOT log at error.
func TestClientDisconnectIsNotLoggedAsError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // hold the stream open until the caller goes away
	}))
	defer upstream.Close()

	target := mustURL(t, upstream.URL)
	reqCtx, cancelReq := context.WithCancel(context.Background())

	lines := captureJSON(t, func() {
		r := httptest.NewRequest("GET", "/conversations/conv-42/events.integrity", nil).WithContext(reqCtx)
		w := httptest.NewRecorder()
		done := make(chan struct{})
		go func() {
			defer close(done)
			serveVia(context.Background(), w, r, target, target, false, "conv-42")
		}()
		cancelReq() // the client navigates away
		<-done
	})

	var sawError bool
	var stream map[string]any
	for _, l := range lines {
		if lvl, _ := l["level"].(string); lvl == "error" {
			sawError = true
			t.Errorf("client disconnect logged at ERROR: %v", l)
		}
		if msg, _ := l["msg"].(string); msg == "stream ended" {
			stream = l
		}
	}
	if sawError {
		return
	}
	if stream == nil {
		t.Fatalf("expected a 'stream ended' line, got %v", lines)
	}
	if got, _ := stream["level"].(string); got != "debug" {
		t.Errorf("level = %q, want DEBUG", got)
	}
	if got, _ := stream["reason"].(string); got != "client_disconnected" {
		t.Errorf("reason = %q, want client_disconnected", got)
	}
	// The whole point of the migration: the line is attributable to a conversation.
	if got, _ := stream["conversation_id"].(string); got != "conv-42" {
		t.Errorf("conversation_id = %q, want conv-42", got)
	}
}

// A genuinely unreachable upstream must still be a 502 logged at error.
func TestUnreachableUpstreamStillErrors(t *testing.T) {
	dead := mustURL(t, "http://127.0.0.1:1") // nothing listens on port 1

	var code int
	lines := captureJSON(t, func() {
		r := httptest.NewRequest("GET", "/conversations/conv-9/cancel", nil)
		w := httptest.NewRecorder()
		serveVia(context.Background(), w, r, dead, dead, false, "conv-9")
		code = w.Code
	})

	if code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", code)
	}
	var found map[string]any
	for _, l := range lines {
		if msg, _ := l["msg"].(string); msg == "proxy failed" {
			found = l
		}
	}
	if found == nil {
		t.Fatalf("expected a 'proxy failed' error line, got %v", lines)
	}
	if got, _ := found["level"].(string); got != "error" {
		t.Errorf("level = %q, want ERROR", got)
	}
	if got, _ := found["reason"].(string); got != "upstream_failure" {
		t.Errorf("reason = %q, want upstream_failure", got)
	}
	if got, _ := found["conversation_id"].(string); got != "conv-9" {
		t.Errorf("conversation_id = %q, want conv-9", got)
	}
	if got, _ := found["dial_failure"].(bool); !got {
		t.Error("dial_failure should be true for a refused connect")
	}
}

// A dial failure against the owner IP must retry via the fallback, logged at warn (not error).
func TestDialFailureRetriesViaFallbackAtWarn(t *testing.T) {
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "served by fallback")
	}))
	defer good.Close()

	dead := mustURL(t, "http://127.0.0.1:1")
	fallback := mustURL(t, good.URL)

	var body string
	var code int
	lines := captureJSON(t, func() {
		r := httptest.NewRequest("GET", "/conversations/conv-7/cancel", nil)
		w := httptest.NewRecorder()
		serveVia(context.Background(), w, r, dead, fallback, true, "conv-7")
		code, body = w.Code, w.Body.String()
	})

	if code != http.StatusOK || body != "served by fallback" {
		t.Fatalf("retry did not reach the fallback: %d %q", code, body)
	}
	var retry map[string]any
	for _, l := range lines {
		if lvl, _ := l["level"].(string); lvl == "error" {
			t.Errorf("a successful fallback retry must not log ERROR: %v", l)
		}
		if msg, _ := l["msg"].(string); msg == "upstream unreachable, retrying via fallback" {
			retry = l
		}
	}
	if retry == nil {
		t.Fatalf("expected a retry line, got %v", lines)
	}
	if got, _ := retry["level"].(string); got != "warn" {
		t.Errorf("level = %q, want WARN", got)
	}
	if got, _ := retry["conversation_id"].(string); got != "conv-7" {
		t.Errorf("conversation_id = %q, want conv-7", got)
	}
}

func TestResolveTargetForReturnsConvID(t *testing.T) {
	cfg := config{namespace: "agent-sandbox", upstreamPort: 8080, clusterIPService: "agent-host"}
	fallback := FallbackURL(cfg.clusterIPService, cfg.namespace, cfg.upstreamPort)
	cache := NewOwnershipCache()
	cache.set("conv-assigned", "10.42.0.2")

	// scoped + assigned -> id and owner IP
	id, u := resolveTargetFor(cfg, cache, httptest.NewRequest("GET", "/conversations/conv-assigned/cancel", nil), fallback)
	if id != "conv-assigned" || u.String() != "http://10.42.0.2:8080" {
		t.Errorf("got (%q,%q)", id, u.String())
	}
	// scoped but UNASSIGNED -> the id is still known (so logs attribute it) with the fallback
	id, u = resolveTargetFor(cfg, cache, httptest.NewRequest("GET", "/conversations/conv-new/cancel", nil), fallback)
	if id != "conv-new" || u.String() != fallback.String() {
		t.Errorf("unassigned: got (%q,%q)", id, u.String())
	}
	// non-scoped -> no id at all
	if id, _ := resolveTargetFor(cfg, cache, httptest.NewRequest("GET", "/healthz", nil), fallback); id != "" {
		t.Errorf("healthz id = %q, want empty", id)
	}
}

func mustURL(t *testing.T, s string) *neturl.URL {
	t.Helper()
	u, err := neturl.Parse(s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return u
}
