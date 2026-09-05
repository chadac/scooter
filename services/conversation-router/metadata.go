// Router-served star/title writes for an IDLE conversation (newRouter gates on no owner pod).
// Why here, and why idle-only: PR #475.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// metaReader / metaWriter are the narrow store deps (satisfied by *Store / *WriteStore), so the
// handler is testable with fakes.
type metaReader interface {
	ConversationByID(ctx context.Context, id string) (*ConversationRow, error)
}

type metaWriter interface {
	SetStarred(ctx context.Context, id string, starred bool) (*ConversationRow, error)
	SetUserTitle(ctx context.Context, id, title string) (*ConversationRow, error)
}

// serveConversationMetadataPatch mirrors agent-host's mutableFor auth + view() response. Why: PR #475.
func serveConversationMetadataPatch(w http.ResponseWriter, r *http.Request, field, id string, store metaReader, writeStore metaWriter, crs crLookup) {
	log := logger("metadata")
	caller := ownerFrom(r)

	// Existence + ownership before the write (mutableFor's rule; anonymous = single-user, may mutate any).
	row, err := store.ConversationByID(r.Context(), id)
	if err != nil {
		log.Error("metadata patch: existence read failed", convAttr(id), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not read conversation")
		return
	}
	if row == nil {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	if caller != "" && row.Owner != nil && *row.Owner != caller {
		writeJSONError(w, http.StatusForbidden, "not your conversation")
		return
	}

	var updated *ConversationRow
	switch field {
	case "starred":
		var body struct {
			Starred *bool `json:"starred"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if body.Starred == nil {
			writeJSONError(w, http.StatusBadRequest, "starred (boolean) is required")
			return
		}
		updated, err = writeStore.SetStarred(r.Context(), id, *body.Starred)
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

	// Same wire row the list emits; a missing CR just yields the default status (UI ignores it here).
	cr, _ := crs.CR(id)
	out := makeListRow(*updated, cr, nil, time.Now().UnixMilli())
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
