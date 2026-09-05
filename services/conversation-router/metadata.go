// PATCH /conversations/:id/{starred,title} for an IDLE conversation, served HERE from the store
// rather than proxied. An idle/suspended conversation has no owner pod, so proxying this PATCH
// lands on an arbitrary ready agent-host pod that doesn't hold the conversation in memory — which
// 404s (agent-host's mutableFor only checks its in-memory session map). Since title/starred are
// pure metadata on the durable row, the router writes them directly.
//
// This is reached ONLY for an idle conversation (newRouter checks the ownership cache first): a
// LIVE conversation is proxied to its owner pod so THAT pod stays the single writer of its
// in-memory copy — metaStore.saveMeta re-upserts the whole row on activity and would otherwise
// clobber a value written from here.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// metaReader reads one conversation's durable row for the existence + ownership check. *Store
// satisfies it; a fake stands in for the handler test.
type metaReader interface {
	ConversationByID(ctx context.Context, id string) (*ConversationRow, error)
}

// metaWriter applies the user-metadata write and returns the updated row. *WriteStore satisfies it.
type metaWriter interface {
	SetStarred(ctx context.Context, id string, starred bool) (*ConversationRow, error)
	SetUserTitle(ctx context.Context, id, title string) (*ConversationRow, error)
}

// serveConversationMetadataPatch validates ownership (mirroring agent-host's mutableFor), applies
// the write, and returns the updated conversation in the same wire shape the list uses (makeListRow
// == agent-host's view()), so the UI client parses it identically to the proxied response.
func serveConversationMetadataPatch(w http.ResponseWriter, r *http.Request, field, id string, store metaReader, writeStore metaWriter, crs crLookup) {
	log := logger("metadata")
	caller := ownerFrom(r)

	// Existence + ownership BEFORE the write. mutableFor's rule: an identified caller may mutate
	// only their own or an unowned conversation; an anonymous caller (no ingress identity) is
	// single-user mode and may mutate any.
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

	// Project into the same wire row the list emits. Existence-in-the-CR-cache is not required
	// here (the caller is writing a real row); a missing CR just yields the default "running"
	// status, which the UI ignores for this response anyway.
	cr, _ := crs.CR(id)
	out := makeListRow(*updated, cr, nil, time.Now().UnixMilli())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// decodeBody reads a JSON request body, tolerating an empty body (treated as {}), matching the
// lenient decode agent-host's handlers use.
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
