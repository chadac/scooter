package main

// Subagent creation — POST /conversations/{parentId}/subagents.
//
// A subagent is a conversation like any other: a CR plus a `conversations` row. It differs only in
// what it INHERITS from its parent (owner, sandbox pod, model) and in carrying parentId, which is
// what makes the controller co-locate it on the parent's pod.
//
// It lives here, in the router, for the same reason top-level create does: there is ONE creator of
// a conversation. The agent-host used to mint the child id itself and write the CR + row from
// spawnChild — a second creation path with its own id minting, its own spec assembly and no row at
// create time, which is exactly the split-ownership that made the `conversations` row's existence
// depend on whichever writer happened to run first. Why: PR #726.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// parentLookup reads the parent conversation a subagent inherits from. Narrow (*Store satisfies
// it) so the route is testable with a hand-written fake, like ConversationCreator.
type parentLookup interface {
	ConversationByID(ctx context.Context, id string) (*ConversationRow, error)
}

// subagentRequest is the accepted body. No id and no owner: the id is minted here and the owner is
// INHERITED from the parent row, so neither is a caller-controlled input.
type subagentRequest struct {
	Title string `json:"title"`
	// Model overrides the parent's for this subagent (a cheaper model for a mechanical
	// subtask). Empty inherits.
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

// serveSubagentCreate creates the child conversation and returns 201, exactly like top-level
// create: no agent-host is consulted, so a subagent can be created while the fleet is at capacity.
//
// `parents` is required — without the parent row there is nothing to inherit, and guessing (an
// empty owner, no sandbox ref) would produce a subagent that lists under nobody and cannot be
// co-located. A pg-less deploy gets 503 rather than a wrong conversation.
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
	// Inherited, NOT taken from the request: the owner is what cost and the "my conversations"
	// filter attribute by, and the sandbox ref is what makes the child share the parent's pod
	// instead of provisioning a second one for the same tree.
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

// subagentResponse is the create response plus what the child inherited. The agent-host needs the
// sandbox ref back: it reuses the parent's pod for the child's bridge, and reading it from the
// response means it does not re-derive (and possibly disagree about) what the router just wrote.
type subagentResponse struct {
	createResponse
	ParentID   string `json:"parentId"`
	SandboxRef string `json:"sandboxRef,omitempty"`
}

// maySpawnSubagent authorizes the create. Spawning a subagent INHERITS the parent's owner, so an
// unrestricted route would let anyone mint a conversation owned by someone else — the same
// escalation the body-`owner` gate on POST /conversations exists to prevent.
//
// Two ways to pass, cheapest first:
//   - the caller IS the parent's owner (a browser-driven spawn, identity from the ingress header);
//   - the caller is a verified in-cluster service (the agent-host, which is what spawns subagents
//     today and never passes through the ingress, so it carries no identity header at all).
//
// A parent with no owner has nothing to escalate to, so it is open — that is the anonymous and
// kube-less dev stacks, which have no identity header and no TokenReview.
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

// specValue reads a string the handler just put in the spec, "" if absent. Not specString: the
// response wants a plain string, and the spec here is this function's own construction.
func specValue(spec map[string]interface{}, k string) string {
	if v, ok := spec[k].(string); ok {
		return v
	}
	return ""
}
