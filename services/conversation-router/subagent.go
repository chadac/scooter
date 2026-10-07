package main

// Subagent creation — POST /conversations/{parentId}/subagents.
//
// A subagent is a conversation like any other: a CR plus a `conversations` row. It differs only in
// what it INHERITS from its parent (owner, sandbox pod, model) and in carrying parentId, which the
// controller co-locates by. Here rather than in the agent-host so there is ONE creator of a
// conversation. Why: PR #726.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// parentLookup reads the parent a subagent inherits from. Narrow (*Store satisfies it) so the
// route is testable without a Postgres, like ConversationCreator.
type parentLookup interface {
	ConversationByID(ctx context.Context, id string) (*ConversationRow, error)
}

// subagentRequest is the accepted body. No id and no owner: both are derived, not caller input.
type subagentRequest struct {
	Title string `json:"title"`
	// Empty inherits the parent's.
	Model string `json:"model"`
}

// defaultSubagentTitle is what the sidebar shows until the child agent emits its own <title>.
const defaultSubagentTitle = "Subagent"

// SubagentCreate reports whether to handle here rather than proxy, returning the parent id.
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

// serveSubagentCreate creates the child and returns 201. No agent-host is consulted, so this
// works at capacity. `parents` is REQUIRED: with no parent row there is nothing to inherit, and
// guessing would produce a subagent owned by nobody that cannot be co-located.
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
		// 404, not 403: answering "forbidden" would confirm that a conversation with this id
		// exists and who owns it, to a caller who has no claim on it.
		log.Warn("subagent create refused", convAttr(parentID), slog.Bool("had_caller_owner", owner != ""))
		writeJSONError(w, http.StatusNotFound, "unknown parent conversation")
		return
	}

	id := uuid.NewString()
	spec := map[string]interface{}{"parentId": parentID}
	// Inherited, NEVER from the request: a caller that could name the owner could mint a
	// conversation owned by someone else, and a caller that could name the sandbox could attach
	// a child to a pod it has no claim on.
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

// subagentResponse is the create response plus what the child inherited. The sandbox ref is
// returned so the host reads the pod it must reuse rather than re-deriving it.
type subagentResponse struct {
	createResponse
	ParentID   string `json:"parentId"`
	SandboxRef string `json:"sandboxRef,omitempty"`
}

// maySpawnSubagent authorizes the create: the child inherits the parent's owner, so an open route
// would let anyone mint a conversation owned by someone else. Pass as the parent's owner, or as a
// verified in-cluster caller (the agent-host carries no identity header). An UNOWNED parent is
// open — nothing to escalate to, and that is the anonymous and kube-less stacks.
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

// specValue reads a string back out of the spec this handler just built, "" if absent.
func specValue(spec map[string]interface{}, k string) string {
	if v, ok := spec[k].(string); ok {
		return v
	}
	return ""
}
