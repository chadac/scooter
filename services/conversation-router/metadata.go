// Router-served title writes, and idle-conversation visibility.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// metaReader and metaWriter are the narrow store deps, satisfied by *Store and *WriteStore.
type metaReader interface {
	ConversationByID(ctx context.Context, id string) (*ConversationRow, error)
}

type metaWriter interface {
	SetUserTitle(ctx context.Context, id, title string) (*ConversationRow, error)
	SetVisibility(ctx context.Context, id, visibility string) (*ConversationRow, error)
}

// routerServesPatch: live visibility belongs to the owner pod.
func routerServesPatch(ctx context.Context, resolver ownerResolver, field, id string) bool {
	if field != "visibility" {
		return true
	}
	return resolver != nil && !resolver.Assigned(ctx, id)
}

// serveConversationMetadataPatch mirrors agent-host's mutableFor auth and view() response.
func serveConversationMetadataPatch(w http.ResponseWriter, r *http.Request, field, id string, store metaReader, writeStore metaWriter) {
	log := logger("metadata")
	caller := ownerFrom(r)

	// Existence and ownership are checked before the write; an anonymous caller may mutate any.
	row, err := store.ConversationByID(r.Context(), id)
	if err != nil {
		log.Error("metadata patch: existence read failed", convAttr(id), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not read conversation")
		return
	}
	// A private conversation the caller may not see answers like a missing one.
	if row == nil || !canAccess(row.Owner, row.Visibility, caller) {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	if caller != "" && row.Owner != nil && *row.Owner != caller {
		writeJSONError(w, http.StatusForbidden, "not your conversation")
		return
	}

	var updated *ConversationRow
	switch field {
	case "title":
		var body struct {
			Title string `json:"title"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		title := strings.TrimSpace(body.Title)
		if title == "" {
			writeJSONError(w, http.StatusBadRequest, "title is required")
			return
		}
		if len(title) > 200 {
			writeJSONError(w, http.StatusBadRequest, "title too long (max 200)")
			return
		}
		updated, err = writeStore.SetUserTitle(r.Context(), id, title)
	case "visibility":
		var body struct {
			Visibility string `json:"visibility"`
			Confirm    bool   `json:"confirm"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if body.Visibility != VisibilityShared && body.Visibility != VisibilityPrivate {
			writeJSONError(w, http.StatusBadRequest, "visibility must be shared or private")
			return
		}
		// Owner only, both ways, unlike star/title: an anonymous caller may not.
		if caller == "" || row.Owner == nil || *row.Owner != caller {
			writeJSONError(w, http.StatusForbidden, "only the owner can change visibility")
			return
		}
		if row.ParentID != nil {
			writeJSONError(w, http.StatusConflict, "a subagent takes its parent's visibility")
			return
		}
		if body.Visibility == VisibilityShared && visibilityOf(row.Visibility) == VisibilityPrivate && !body.Confirm {
			writeJSONError(w, http.StatusConflict, "making a private conversation shared needs confirm: true")
			return
		}
		updated, err = writeStore.SetVisibility(r.Context(), id, body.Visibility)
	default:
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		log.Error("metadata patch: write failed", convAttr(id), slog.String("field", field), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not update conversation")
		return
	}
	if updated == nil {
		// Deleted between the auth read and the write.
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}

	// The same wire row the list emits.
	out := makeListRow(*updated, nil, time.Now().UnixMilli())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// decodeBody reads a JSON body, tolerating an empty one (treated as {}), like agent-host's handlers.
func decodeBody(r *http.Request, v interface{}) error {
	if r.Body == nil {
		return nil
	}
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil && err.Error() != "EOF" {
		return err
	}
	return nil
}
