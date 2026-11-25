package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Creating a conversation is a control-plane write that consults no agent-host, so it
// succeeds even when the fleet is at capacity and the conversation is Pending until assigned.

// NewConversation is the conversation to persist: its id, the spec fields (owner, model,
// parentId, sandboxRef) that become row columns, and the title.
type NewConversation struct {
	Name  string
	Spec  map[string]interface{}
	Title string
}

// ConversationCreator persists a new conversation as its `conversations` row.
type ConversationCreator interface {
	Create(ctx context.Context, c NewConversation) error
}

// conversationRowWriter inserts the create-time row; *WriteStore is the real one.
type conversationRowWriter interface {
	CreateConversation(ctx context.Context, c NewConversation) error
}

// rowCreator is the cluster create path: the row is the conversation, so its insert is the create.
type rowCreator struct {
	rows conversationRowWriter
}

func (r rowCreator) Create(ctx context.Context, c NewConversation) error {
	if err := r.rows.CreateConversation(ctx, c); err != nil {
		return fmt.Errorf("could not write the conversation row: %w", err)
	}
	return nil
}

// unavailableCreator refuses every create when the cluster path has no write store, since a
// conversation without its row does not exist.
type unavailableCreator struct{}

func (unavailableCreator) Create(context.Context, NewConversation) error {
	return errors.New("no conversations write store: cannot create conversations")
}

// createRequest is the accepted body; the server mints the id.
type createRequest struct {
	Title    string `json:"title"`
	Model    string `json:"model"`
	ParentID string `json:"parentId"`
	// Owner is honored only for a TokenReview-verified in-cluster caller (see trustedcaller.go) and ignored from anyone else.
	Owner string `json:"owner"`
	// Visibility is "shared" (the default) or "private"; private needs an owner to be private for.
	Visibility string `json:"visibility"`
	// Oneshot deletes the conversation, its sandbox and its volumes once its last run ends.
	Oneshot bool `json:"oneshot"`
}

type createResponse struct {
	// The conversation id, which is also the thread id.
	ID         string `json:"id"`
	Status     string `json:"status"`
	Title      string `json:"title"`
	CreatedAt  int64  `json:"createdAt"`
	Owner      string `json:"owner,omitempty"`
	Visibility string `json:"visibility"`
	Oneshot    bool   `json:"oneshot,omitempty"`
}

// IsConversationCreate reports whether to handle here rather than proxy.
func IsConversationCreate(method, path string) bool {
	return method == http.MethodPost && strings.TrimSuffix(path, "/") == "/conversations"
}

// modelRe guards the only client-controlled string that reaches the CR spec.
var modelRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// serveConversationCreate returns 201 without waiting for assignment; `owner` is the ingress-resolved caller, and a body `owner` from a `trusted` in-cluster caller wins over it.
func serveConversationCreate(w http.ResponseWriter, r *http.Request, creator ConversationCreator, owner string, trusted TrustedCaller) {
	var req createRequest
	if r.Body != nil {
		dec := json.NewDecoder(r.Body)
		if err := dec.Decode(&req); err != nil && err.Error() != "EOF" {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
	}

	if req.Model != "" && !modelRe.MatchString(req.Model) {
		writeJSONError(w, http.StatusBadRequest, "invalid model")
		return
	}

	if req.Owner != "" && req.Owner != owner {
		// Verify only when it would change the outcome, so a browser create never pays the TokenReview round-trip.
		if trusted != nil && trusted(r.Context(), r) {
			owner = req.Owner
		} else {
			logger("create").Warn("ignored a body owner from an unverified caller",
				slog.Bool("had_header_owner", owner != ""))
		}
	}

	visibility := req.Visibility
	if visibility == "" {
		visibility = VisibilityShared
	}
	if visibility != VisibilityShared && visibility != VisibilityPrivate {
		writeJSONError(w, http.StatusBadRequest, "visibility must be shared or private")
		return
	}
	if visibility == VisibilityPrivate && owner == "" {
		writeJSONError(w, http.StatusBadRequest, "a private conversation needs a signed-in owner")
		return
	}

	// A subagent already dies with its parent.
	if req.Oneshot && req.ParentID != "" {
		writeJSONError(w, http.StatusBadRequest, "oneshot applies only to a top-level conversation")
		return
	}

	id := uuid.NewString()
	spec := map[string]interface{}{}
	if owner != "" {
		spec["owner"] = owner
	}
	if req.Model != "" {
		spec["model"] = req.Model
	}
	if req.ParentID != "" {
		spec["parentId"] = req.ParentID
	}
	if visibility == VisibilityPrivate {
		spec["visibility"] = visibility
	}
	if req.Oneshot {
		spec["oneshot"] = true
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := creator.Create(ctx, NewConversation{Name: id, Spec: spec, Title: req.Title}); err != nil {
		logger("create").Error("conversation create failed",
			convAttr(id),
			slog.String("owner", owner),
			errAttr(err))
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("could not create conversation: %v", err))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(createResponse{
		ID:        id,
		Status:    "pending",
		Title:     req.Title,
		CreatedAt: time.Now().UnixMilli(),
		Owner:     owner,
		// As requested; a subagent of a private parent is stored private regardless.
		Visibility: visibility,
		Oneshot:    req.Oneshot,
	})
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
