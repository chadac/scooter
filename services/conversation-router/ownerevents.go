// Folder services push contrib changes to one user's list streams.
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
)

// IsOwnerEventPost matches POST /conversations/events.
func IsOwnerEventPost(method, path string) bool {
	parts := splitPath(path)
	return method == http.MethodPost && len(parts) == 2 && parts[0] == "conversations" && parts[1] == "events"
}

// serveOwnerEvent publishes a folder service's {contrib, conversations?} to the user it names.
func serveOwnerEvent(w http.ResponseWriter, r *http.Request, n ownerNotifier, services FolderService) {
	owner, service := folderCaller(r, services)
	if !service {
		writeJSONError(w, http.StatusForbidden, "only a folder service can publish events")
		return
	}
	var body struct {
		Contrib       string   `json:"contrib"`
		Conversations []string `json:"conversations"`
	}
	if decodeBody(r, &body) != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if !contribName.MatchString(body.Contrib) {
		writeJSONError(w, http.StatusBadRequest, "contrib must be a contrib name")
		return
	}
	if len(body.Conversations) > maxEventConversations {
		writeJSONError(w, http.StatusBadRequest, "too many conversations; send none to mean all")
		return
	}
	for _, id := range body.Conversations {
		if !eventConvID.MatchString(id) {
			writeJSONError(w, http.StatusBadRequest, "conversations must be conversation ids")
			return
		}
	}
	payload, err := json.Marshal(ownerEvent{Owner: &owner, Contrib: body.Contrib, Conversations: body.Conversations})
	if err == nil {
		err = n.NotifyFolders(r.Context(), payload)
	}
	if err != nil {
		logger("folders").Warn("owner event notify failed", errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not publish the event")
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// maxEventConversations keeps a NOTIFY payload under Postgres's 8000 bytes.
const maxEventConversations = 100

var (
	// contribName matches the names manifests give contribs.
	contribName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	eventConvID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// ownerNotifier sends a NOTIFY payload to every replica's folder listener.
type ownerNotifier interface {
	NotifyFolders(ctx context.Context, payload []byte) error
}

// ownerEvent is a foldersChannel payload; empty Contrib: a folder change.
type ownerEvent struct {
	Owner         *string  `json:"owner"`
	Contrib       string   `json:"contrib,omitempty"`
	Conversations []string `json:"conversations,omitempty"`
}

// NotifyFolders sends payload on foldersChannel, reaching every replica.
func (s *WriteStore) NotifyFolders(ctx context.Context, payload []byte) error {
	_, err := s.pool.Exec(ctx, `SELECT pg_notify($1, $2)`, foldersChannel, string(payload))
	return err
}

// folderNotify parses a foldersChannel payload into its owner and frame.
func folderNotify(payload string) (owner string, frame []byte, ok bool) {
	var e ownerEvent
	if err := json.Unmarshal([]byte(payload), &e); err != nil || e.Owner == nil {
		return "", nil, false
	}
	if e.Contrib == "" {
		return *e.Owner, []byte(`{"kind":"folders"}`), true
	}
	ids := e.Conversations
	if ids == nil {
		ids = []string{}
	}
	frame, err := json.Marshal(struct {
		Kind          string   `json:"kind"`
		Contrib       string   `json:"contrib"`
		Conversations []string `json:"conversations"`
	}{Kind: "contrib", Contrib: e.Contrib, Conversations: ids})
	if err != nil {
		return "", nil, false
	}
	return *e.Owner, frame, true
}
