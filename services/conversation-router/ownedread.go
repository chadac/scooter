package main

// Owned reads: a verified service reads conversations owned by a source conversation's owner.
// The owner comes from the source row, never the request, so a reader sees only what that
// user could see of their own, and only on behalf of a conversation that user owns.
// Only private sources qualify; others may drive shared ones.

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/chadac-me/scooter/conversation-router/svcauth"
)

// ownedListing lists every conversation and looks one up.
type ownedListing interface {
	parentLookup
	Conversations(ctx context.Context) ([]ConversationRow, error)
}

// OwnedRead matches GET /conversations/{source}/owned[/{target}/messages].
// An empty target is the list.
func OwnedRead(method, path string) (sourceID, targetID string, ok bool) {
	if method != http.MethodGet {
		return "", "", false
	}
	parts := splitPath(path)
	if len(parts) < 3 || parts[0] != "conversations" || parts[1] == "" || parts[2] != "owned" {
		return "", "", false
	}
	switch {
	case len(parts) == 3:
		return parts[1], "", true
	case len(parts) == 5 && parts[3] != "" && parts[4] == "messages":
		return parts[1], parts[3], true
	}
	return "", "", false
}

// getFunc runs an internal GET as `owner`, returning status, content type and body.
type getFunc func(ctx context.Context, path string, query url.Values, owner string) (int, string, string)

// serveOwnedRead serves the owner's list, or one owned conversation's messages.
func serveOwnedRead(w http.ResponseWriter, r *http.Request, rows ownedListing, sourceID, targetID string, reader TrustedCaller, get getFunc) {
	log := logger("owned")
	// Refuse with 404 until the source is proven.
	if reader == nil || rows == nil {
		writeJSONError(w, http.StatusNotFound, "unknown source conversation")
		return
	}
	if !reader(r.Context(), r) {
		log.Warn("owned read refused: caller is not a reader", convAttr(sourceID))
		writeJSONError(w, http.StatusNotFound, "unknown source conversation")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	src, err := rows.ConversationByID(ctx, sourceID)
	if err != nil {
		log.Error("source lookup failed", convAttr(sourceID), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not read the source conversation")
		return
	}
	if src == nil {
		writeJSONError(w, http.StatusNotFound, "unknown source conversation")
		return
	}
	owner := derefStr(src.Owner)
	// A shared or unowned source owns nothing.
	if visibilityOf(src.Visibility) != VisibilityPrivate {
		owner = ""
	}

	if targetID == "" {
		metas, err := rows.Conversations(ctx)
		if err != nil {
			log.Warn("conversation list read failed", errAttr(err))
			writeJSONError(w, http.StatusServiceUnavailable, "conversation store read failed")
			return
		}
		list := []listRow{}
		if owner != "" {
			list = assembleList(metas, nil, time.Now().UnixMilli(), owner, "mine")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(list)
		return
	}

	target, err := rows.ConversationByID(ctx, targetID)
	if err != nil {
		log.Error("target lookup failed", convAttr(targetID), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not read the target conversation")
		return
	}
	// One 404 for unknown and not-owned, so the route confirms nothing.
	if target == nil || owner == "" || derefStr(target.Owner) != owner {
		writeJSONError(w, http.StatusNotFound, "no such conversation owned by the source's owner")
		return
	}
	query, ok := pagingQuery(r.URL.Query())
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "before and limit must be non-negative integers")
		return
	}
	log.Info("owned read", convAttr(targetID), slog.String("source_id", sourceID))
	status, contentType, body := get(ctx, "/conversations/"+targetID+"/messages", query, owner)
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// pagingQuery keeps only the integer paging parameters.
func pagingQuery(in url.Values) (url.Values, bool) {
	out := url.Values{}
	for _, k := range []string{"before", "limit"} {
		v := in.Get(k)
		if v == "" {
			continue
		}
		if n, err := strconv.ParseInt(v, 10, 64); err != nil || n < 0 {
			return nil, false
		}
		out.Set(k, v)
	}
	return out, true
}

// readerServiceAccounts is the owned-read allowlist, separate from spawners and asserters.
func readerServiceAccounts() map[string]bool {
	return svcauth.ParseAllowlist(env("CONVERSATION_READER_SERVICE_ACCOUNTS", ""))
}

// internalGet runs a GET through `next` with the owner's identity stamped.
func internalGet(next http.Handler, identity identityConfig) getFunc {
	return func(ctx context.Context, path string, query url.Values, owner string) (int, string, string) {
		target := path
		if len(query) > 0 {
			target += "?" + query.Encode()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return http.StatusInternalServerError, "", ""
		}
		req.Header.Set(identity.userHeader, owner)
		if identity.albIdentityHeader != "" {
			req.Header.Set(identity.albIdentityHeader, owner)
		}
		rec := &statusRecorder{header: http.Header{}}
		next.ServeHTTP(rec, req)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		return rec.status, strings.TrimSpace(rec.header.Get("Content-Type")), rec.body.String()
	}
}
