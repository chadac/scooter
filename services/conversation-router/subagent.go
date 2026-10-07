package main

// Subagent creation: one creator of a conversation (PR #726).

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// parentLookup reads the parent a subagent inherits from.
type parentLookup interface {
	ConversationByID(ctx context.Context, id string) (*ConversationRow, error)
}

// subagentRequest is the body; id and owner are derived.
type subagentRequest struct {
	Title string `json:"title"`
	// Empty inherits the parent's.
	Model string `json:"model"`
}

// defaultSubagentTitle shows until the child emits its own <title>.
const defaultSubagentTitle = "Subagent"

// SubagentCreate returns the parent id when this route matches.
func SubagentCreate(method, path string) (parentID string, ok bool) {
	if method != http.MethodPost {
		return "", false
	}
	parts := splitPath(path)
	if len(parts) != 3 || parts[0] != "conversations" || parts[2] != "subagents" {
		return "", false
	}
	if parts[1] == "" {
		return "", false
	}
	return parts[1], true
}

// serveSubagentCreate needs `parents`: nothing else to inherit from.
func serveSubagentCreate(w http.ResponseWriter, r *http.Request, creator ConversationCreator, parents parentLookup, parentID, owner string, trusted TrustedCaller) {
	log := logger("subagent-create")
	if parents == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "conversation store unavailable")
		return
	}

	var req subagentRequest
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

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	parent, err := parents.ConversationByID(ctx, parentID)
	if err != nil {
		log.Error("parent lookup failed", convAttr(parentID), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not read the parent conversation")
		return
	}
	if parent == nil {
		writeJSONError(w, http.StatusNotFound, "unknown parent conversation")
		return
	}

	if !maySpawnSubagent(r, parent, owner, trusted) {
		// 404, not 403, which would confirm the parent.
		log.Warn("subagent create refused", convAttr(parentID), slog.Bool("had_caller_owner", owner != ""))
		writeJSONError(w, http.StatusNotFound, "unknown parent conversation")
		return
	}

	id := uuid.NewString()
	spec := map[string]interface{}{"parentId": parentID}
	// Inherited, NEVER from the request, which could name another owner.
	if parent.Owner != nil && *parent.Owner != "" {
		spec["owner"] = *parent.Owner
	}
	if parent.SandboxRef != nil && *parent.SandboxRef != "" {
		spec["sandboxRef"] = *parent.SandboxRef
	}
	if model := req.Model; model != "" {
		spec["model"] = model
	} else if parent.Model != nil && *parent.Model != "" {
		spec["model"] = *parent.Model
	}

	title := req.Title
	if title == "" {
		title = defaultSubagentTitle
	}
	if err := creator.Create(ctx, NewConversation{Name: id, Spec: spec, Title: title}); err != nil {
		log.Error("subagent create failed", convAttr(id), slog.String("parent_id", parentID), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("could not create subagent: %v", err))
		return
	}
	log.Info("subagent created", convAttr(id), slog.String("parent_id", parentID))

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(subagentResponse{
		createResponse: createResponse{
			ID:        id,
			Status:    "pending",
			Title:     title,
			CreatedAt: time.Now().UnixMilli(),
			Owner:     specValue(spec, "owner"),
		},
		ParentID:   parentID,
		SandboxRef: specValue(spec, "sandboxRef"),
	})
}

// subagentResponse adds what the child inherited.
type subagentResponse struct {
	createResponse
	ParentID   string `json:"parentId"`
	SandboxRef string `json:"sandboxRef,omitempty"`
}

// maySpawnSubagent stops a stranger minting someone else's conversation.
func maySpawnSubagent(r *http.Request, parent *ConversationRow, owner string, trusted TrustedCaller) bool {
	if parent.Owner == nil || *parent.Owner == "" {
		return true
	}
	if owner != "" && owner == *parent.Owner {
		return true
	}
	// Only now pay the TokenReview round-trip.
	return trusted != nil && trusted(r.Context(), r)
}

// specValue reads a string back out of the built spec.
func specValue(spec map[string]interface{}, k string) string {
	if v, ok := spec[k].(string); ok {
		return v
	}
	return ""
}
