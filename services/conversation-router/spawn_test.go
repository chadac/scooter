package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type delivered struct{ convID, owner, text, source string }

type fakeDeliver struct {
	calls []delivered
	err   error
}

func (f *fakeDeliver) fn(_ context.Context, convID, owner, text, source string) error {
	f.calls = append(f.calls, delivered{convID, owner, text, source})
	return f.err
}

func allowAll(context.Context, *http.Request) bool { return true }
func denyAll(context.Context, *http.Request) bool  { return false }

func aSource(id, visibility string) *ConversationRow {
	return &ConversationRow{
		ID: id, ThreadID: id, Title: "Source", Owner: str("alice"),
		Model: str("model-fast"), SandboxRef: str("conv-abc123"), ParentID: str("root-1"), Visibility: visibility,
	}
}

type spawnCase struct {
	creator *fakeCreator
	sources *fakeParents
	deliver *fakeDeliver
	spawner TrustedCaller
	limiter *spawnLimiter
}

func newSpawnCase(src *ConversationRow) *spawnCase {
	rows := map[string]*ConversationRow{}
	if src != nil {
		rows[src.ID] = src
	}
	return &spawnCase{
		creator: &fakeCreator{}, sources: &fakeParents{rows: rows}, deliver: &fakeDeliver{},
		spawner: allowAll, limiter: newSpawnLimiter(10, time.Hour),
	}
}

func (c *spawnCase) post(t *testing.T, sourceID, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/conversations/"+sourceID+"/spawns", strings.NewReader(body))
	w := httptest.NewRecorder()
	var deliver deliverFunc
	if c.deliver != nil {
		deliver = c.deliver.fn
	}
	serveConversationSpawn(w, r, c.creator, c.sources, sourceID, c.spawner, c.limiter, deliver)
	return w
}

func TestConversationSpawnRoute(t *testing.T) {
	if id, ok := ConversationSpawn(http.MethodPost, "/conversations/abc/spawns"); !ok || id != "abc" {
		t.Errorf("want abc, got %q %v", id, ok)
	}
	for _, p := range []string{"/conversations//spawns", "/conversations/abc/spawns/x", "/conversations/abc/subagents"} {
		if _, ok := ConversationSpawn(http.MethodPost, p); ok {
			t.Errorf("%s must not match", p)
		}
	}
	if _, ok := ConversationSpawn(http.MethodGet, "/conversations/abc/spawns"); ok {
		t.Error("GET must not match")
	}
}

// Owner and visibility come from the source row; the body cannot name another owner.
func TestSpawnDerivesOwnerAndVisibilityFromSource(t *testing.T) {
	for _, vis := range []string{VisibilityShared, VisibilityPrivate} {
		c := newSpawnCase(aSource("src-1", vis))
		w := c.post(t, "src-1", `{"title":"Follow up","prompt":"do the thing","owner":"mallory","visibility":"shared","source":"handoff"}`)
		if w.Code != http.StatusCreated {
			t.Fatalf("%s: want 201, got %d (%s)", vis, w.Code, w.Body.String())
		}
		var resp createResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.Owner != "alice" || resp.Visibility != vis || resp.Title != "Follow up" {
			t.Errorf("%s: response %+v", vis, resp)
		}
		if len(c.creator.calls) != 1 || c.creator.calls[0].name != resp.ID {
			t.Fatalf("%s: not created under the returned id: %+v", vis, c.creator.calls)
		}
		spec := c.creator.calls[0].spec
		if spec["owner"] != "alice" {
			t.Errorf("%s: owner must come from the source: %+v", vis, spec)
		}
		if _, has := spec["parentId"]; has {
			t.Errorf("%s: a spawn is top-level: %+v", vis, spec)
		}
		if _, has := spec["sandboxRef"]; has {
			t.Errorf("%s: a spawn gets its own sandbox: %+v", vis, spec)
		}
		if got, _ := spec["visibility"].(string); visibilityOf(got) != vis {
			t.Errorf("%s: visibility must follow the source: %+v", vis, spec)
		}
		want := delivered{resp.ID, "alice", "do the thing", "handoff"}
		if len(c.deliver.calls) != 1 || c.deliver.calls[0] != want {
			t.Errorf("%s: delivered %+v, want %+v", vis, c.deliver.calls, want)
		}
	}
}

func TestSpawnDefaultsSourceTag(t *testing.T) {
	c := newSpawnCase(aSource("src-1", ""))
	if w := c.post(t, "src-1", `{"prompt":"hi"}`); w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d", w.Code)
	}
	if c.deliver.calls[0].source != defaultSpawnSource {
		t.Errorf("want %q, got %q", defaultSpawnSource, c.deliver.calls[0].source)
	}
}

func TestSpawnModelIsDefaultUnlessAsked(t *testing.T) {
	c := newSpawnCase(aSource("src-1", ""))
	if w := c.post(t, "src-1", `{"prompt":"hi"}`); w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d", w.Code)
	}
	if m, has := c.creator.calls[0].spec["model"]; has {
		t.Errorf("no model must not inherit the source's, got %v", m)
	}
	if w := c.post(t, "src-1", `{"prompt":"hi","model":"model-big"}`); w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d", w.Code)
	}
	if m := c.creator.calls[1].spec["model"]; m != "model-big" {
		t.Errorf("an asked-for model must pass through, got %v", m)
	}
}

// Every refusal before the source is proven answers 404 and creates nothing.
func TestSpawnRefusesUnverifiedCallers(t *testing.T) {
	for name, spawner := range map[string]TrustedCaller{"disabled": nil, "unverified": denyAll} {
		c := newSpawnCase(aSource("src-1", ""))
		c.spawner = spawner
		w := c.post(t, "src-1", `{"prompt":"hi"}`)
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: want 404, got %d", name, w.Code)
		}
		if len(c.creator.calls) != 0 || len(c.deliver.calls) != 0 {
			t.Errorf("%s: nothing may be created or delivered", name)
		}
	}
}

func TestSpawnUnknownSource(t *testing.T) {
	c := newSpawnCase(nil)
	if w := c.post(t, "nope", `{"prompt":"hi"}`); w.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", w.Code)
	}
	if len(c.creator.calls) != 0 {
		t.Error("nothing may be created")
	}
}

func TestSpawnSourceLookupFailure(t *testing.T) {
	c := newSpawnCase(nil)
	c.sources.err = errors.New("db down")
	if w := c.post(t, "src-1", `{"prompt":"hi"}`); w.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d", w.Code)
	}
}

func TestSpawnValidatesBody(t *testing.T) {
	cases := map[string]string{
		"not json":     `{`,
		"no prompt":    `{"title":"x"}`,
		"blank prompt": `{"prompt":"   "}`,
		"long prompt":  `{"prompt":"` + strings.Repeat("a", maxSpawnPrompt+1) + `"}`,
		"long title":   `{"prompt":"hi","title":"` + strings.Repeat("t", maxSpawnTitle+1) + `"}`,
		"bad model":    `{"prompt":"hi","model":"a b"}`,
		"bad source":   `{"prompt":"hi","source":"User"}`,
	}
	for name, body := range cases {
		c := newSpawnCase(aSource("src-1", ""))
		if w := c.post(t, "src-1", body); w.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d (%s)", name, w.Code, w.Body.String())
		}
		if len(c.creator.calls) != 0 {
			t.Errorf("%s: nothing may be created", name)
		}
	}
}

func TestSpawnRateLimitPerSource(t *testing.T) {
	c := newSpawnCase(aSource("src-1", ""))
	c.sources.rows["src-2"] = aSource("src-2", "")
	c.limiter = newSpawnLimiter(2, time.Hour)
	now := time.Unix(1_000_000, 0)
	c.limiter.now = func() time.Time { return now }
	for i := 0; i < 2; i++ {
		if w := c.post(t, "src-1", `{"prompt":"hi"}`); w.Code != http.StatusCreated {
			t.Fatalf("spawn %d: want 201, got %d", i, w.Code)
		}
	}
	w := c.post(t, "src-1", `{"prompt":"hi"}`)
	if w.Code != http.StatusTooManyRequests || !strings.Contains(w.Body.String(), "2 conversations") {
		t.Fatalf("want 429 naming the limit, got %d (%s)", w.Code, w.Body.String())
	}
	if w := c.post(t, "src-2", `{"prompt":"hi"}`); w.Code != http.StatusCreated {
		t.Errorf("another source has its own budget, got %d", w.Code)
	}
	now = now.Add(time.Hour)
	if w := c.post(t, "src-1", `{"prompt":"hi"}`); w.Code != http.StatusCreated {
		t.Errorf("the window must slide, got %d", w.Code)
	}
}

// A failed first message still reports the id, so the caller can clean up.
func TestSpawnDeliveryFailureReportsID(t *testing.T) {
	c := newSpawnCase(aSource("src-1", ""))
	c.deliver.err = errors.New("no pod")
	w := c.post(t, "src-1", `{"prompt":"hi"}`)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d", w.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["id"] == "" || body["id"] != c.creator.calls[0].name {
		t.Errorf("the created id must be reported: %+v", body)
	}
}

func TestInternalDeliverStampsOwner(t *testing.T) {
	identity := identityConfig{userHeader: "x-auth-user", albIdentityHeader: "x-amzn-oidc-identity"}
	var got *http.Request
	var gotBody string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusAccepted)
	})
	if err := internalDeliver(next, identity)(context.Background(), "new-1", "alice", "hello", "handoff"); err != nil {
		t.Fatal(err)
	}
	if got.Method != http.MethodPost || got.URL.Path != "/conversations/new-1/messages" {
		t.Errorf("wrong request: %s %s", got.Method, got.URL.Path)
	}
	if got.Header.Get("x-auth-user") != "alice" || got.Header.Get("x-amzn-oidc-identity") != "alice" {
		t.Errorf("owner not stamped: %v", got.Header)
	}
	var body map[string]string
	_ = json.Unmarshal([]byte(gotBody), &body)
	if body["text"] != "hello" || body["source"] != "handoff" {
		t.Errorf("body %s", gotBody)
	}
}

func TestInternalDeliverReportsRefusal(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusForbidden)
	})
	err := internalDeliver(next, identityConfig{userHeader: "x-auth-user"})(context.Background(), "new-1", "", "hi", "spawn")
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("want a 403 error, got %v", err)
	}
}
