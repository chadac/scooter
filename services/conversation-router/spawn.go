package main

// Spawn: a verified service opens a new top-level conversation for a source conversation's owner.
// Owner and visibility come from the source row, never the request, so a spawner can create
// work only for a user it already serves, and only as visible as the conversation it serves.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/chadac-me/scooter/conversation-router/svcauth"
	"github.com/google/uuid"
)

// ConversationSpawn returns the source id when this route matches.
func ConversationSpawn(method, path string) (sourceID string, ok bool) {
	if method != http.MethodPost {
		return "", false
	}
	parts := splitPath(path)
	if len(parts) != 3 || parts[0] != "conversations" || parts[2] != "spawns" || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}

// spawnRequest is the body; owner and visibility are derived.
type spawnRequest struct {
	Title  string `json:"title"`
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	// Tags the first message; agent-host refuses human sources.
	Source string `json:"source"`
}

const (
	defaultSpawnSource = "spawn"
	maxSpawnPrompt     = 64 << 10
	maxSpawnTitle      = 200
)

// spawnSourceRe mirrors agent-host's isPostableSource shape.
var spawnSourceRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

// deliverFunc queues the first message as `owner`.
type deliverFunc func(ctx context.Context, convID, owner, text, source string) error

// serveConversationSpawn creates the conversation, then delivers its first message.
func serveConversationSpawn(w http.ResponseWriter, r *http.Request, creator ConversationCreator, sources parentLookup, sourceID string, spawner TrustedCaller, limiter *spawnLimiter, deliver deliverFunc) {
	log := logger("spawn")
	// Refuse with 404 until the source is proven.
	if spawner == nil || sources == nil {
		writeJSONError(w, http.StatusNotFound, "unknown source conversation")
		return
	}
	if !spawner(r.Context(), r) {
		log.Warn("spawn refused: caller is not a spawner", convAttr(sourceID))
		writeJSONError(w, http.StatusNotFound, "unknown source conversation")
		return
	}

	var req spawnRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 2*maxSpawnPrompt)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	req.Prompt = strings.TrimSpace(req.Prompt)
	if req.Source == "" {
		req.Source = defaultSpawnSource
	}
	switch {
	case req.Prompt == "":
		writeJSONError(w, http.StatusBadRequest, "prompt required")
		return
	case len(req.Prompt) > maxSpawnPrompt:
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("prompt exceeds %d bytes", maxSpawnPrompt))
		return
	case len(req.Title) > maxSpawnTitle:
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("title exceeds %d bytes", maxSpawnTitle))
		return
	case req.Model != "" && !modelRe.MatchString(req.Model):
		writeJSONError(w, http.StatusBadRequest, "invalid model")
		return
	case !spawnSourceRe.MatchString(req.Source):
		writeJSONError(w, http.StatusBadRequest, "source must be a lowercase name")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	src, err := sources.ConversationByID(ctx, sourceID)
	if err != nil {
		log.Error("source lookup failed", convAttr(sourceID), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not read the source conversation")
		return
	}
	if src == nil {
		writeJSONError(w, http.StatusNotFound, "unknown source conversation")
		return
	}
	if !limiter.allow(sourceID) {
		w.Header().Set("Retry-After", "600")
		writeJSONError(w, http.StatusTooManyRequests,
			fmt.Sprintf("this conversation already spawned %d conversations in the last %s", limiter.max, limiter.window))
		return
	}

	owner := ""
	if src.Owner != nil {
		owner = *src.Owner
	}
	visibility := visibilityOf(src.Visibility)
	id := uuid.NewString()
	// Top-level, with its own sandbox: no parentId or sandboxRef.
	spec := map[string]interface{}{}
	if owner != "" {
		spec["owner"] = owner
	}
	if req.Model != "" {
		spec["model"] = req.Model
	}
	if visibility == VisibilityPrivate {
		spec["visibility"] = visibility
	}
	if err := creator.Create(ctx, NewConversation{Name: id, Spec: spec, Title: req.Title}); err != nil {
		log.Error("spawn create failed", convAttr(id), slog.String("source_id", sourceID), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("could not create conversation: %v", err))
		return
	}
	log.Info("conversation spawned", convAttr(id), slog.String("source_id", sourceID),
		slog.String("owner", owner), slog.String("visibility", visibility), slog.String("source", req.Source))

	w.Header().Set("Content-Type", "application/json")
	if err := deliver(ctx, id, owner, req.Prompt, req.Source); err != nil {
		log.Error("spawn prompt failed", convAttr(id), slog.String("source_id", sourceID), errAttr(err))
		// Report the id so the caller can clean up.
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "conversation created but its prompt failed: " + err.Error(), "id": id})
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(createResponse{
		ID: id, Status: "pending", Title: req.Title, CreatedAt: time.Now().UnixMilli(),
		Owner: owner, Visibility: visibility,
	})
}

// spawnServiceAccounts is the spawn allowlist, separate from owner asserters.
func spawnServiceAccounts() map[string]bool {
	return svcauth.ParseAllowlist(env("CONVERSATION_SPAWNER_SERVICE_ACCOUNTS", ""))
}

// spawnLimiter caps spawns per source, per window, per replica.
type spawnLimiter struct {
	max    int
	window time.Duration
	now    func() time.Time

	mu   sync.Mutex
	seen map[string][]time.Time
}

func newSpawnLimiter(max int, window time.Duration) *spawnLimiter {
	return &spawnLimiter{max: max, window: window, now: time.Now, seen: map[string][]time.Time{}}
}

func (l *spawnLimiter) allow(sourceID string) bool {
	if l.max <= 0 {
		return true
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	recent := l.seen[sourceID][:0]
	for _, t := range l.seen[sourceID] {
		if now.Sub(t) < l.window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= l.max {
		l.seen[sourceID] = recent
		return false
	}
	l.seen[sourceID] = append(recent, now)
	if len(l.seen) > 4096 { // bounded: forget sources idle for a window
		for id, ts := range l.seen {
			if len(ts) == 0 || now.Sub(ts[len(ts)-1]) >= l.window {
				delete(l.seen, id)
			}
		}
	}
	return true
}

// internalDeliver posts through `next` with the owner's identity stamped.
func internalDeliver(next http.Handler, identity identityConfig) deliverFunc {
	return func(ctx context.Context, convID, owner, text, source string) error {
		body, err := json.Marshal(map[string]string{"text": text, "source": source})
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "/conversations/"+convID+"/messages", strings.NewReader(string(body)))
		if err != nil {
			return err
		}
		req.Header.Set("content-type", "application/json")
		if owner != "" {
			req.Header.Set(identity.userHeader, owner)
			req.Header.Set(identity.albIdentityHeader, owner)
		}
		rec := &statusRecorder{header: http.Header{}}
		next.ServeHTTP(rec, req)
		if rec.status >= 300 {
			return fmt.Errorf("agent-host answered %d: %s", rec.status, strings.TrimSpace(rec.body.String()))
		}
		return nil
	}
}

// statusRecorder captures an internal request's status and body.
type statusRecorder struct {
	header http.Header
	status int
	body   strings.Builder
}

func (s *statusRecorder) Header() http.Header { return s.header }

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	s.WriteHeader(http.StatusOK)
	return s.body.Write(b)
}
