// Per-user sidebar folders and stars, served without any pod.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// StarredFolderID is the wire id of every user's built-in Starred folder.
const StarredFolderID = "starred"

// foldersChannel carries each folder change's owner.
const foldersChannel = "conversation_folders_changed"

const (
	maxFolderName = 100
	maxFolderIcon = 40
)

var (
	errFolderNameTaken = errors.New("folder name taken")
	errFolderNotFound  = errors.New("folder not found")
)

// Folder is one entry of GET /folders; Starred always comes first.
type Folder struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Icon     string  `json:"icon,omitempty"`
	Kind     string  `json:"kind"`
	Position float64 `json:"position"`
}

// FolderPatch is a PATCH body: nil keeps a field, "" clears Icon.
type FolderPatch struct {
	Name     *string  `json:"name"`
	Icon     *string  `json:"icon"`
	Position *float64 `json:"position"`
}

// FolderList is the GET /folders body.
type FolderList struct {
	Folders    []Folder          `json:"folders"`
	Placements map[string]string `json:"placements"`
}

// folderStore is the narrow store dep, satisfied by *WriteStore.
type folderStore interface {
	Folders(ctx context.Context, owner string) (FolderList, error)
	CreateFolder(ctx context.Context, owner, name string) (Folder, error)
	UpdateFolder(ctx context.Context, owner, id string, p FolderPatch) error
	DeleteFolder(ctx context.Context, owner, id string) error
	// PlaceConversation files a conversation; folderID "" unfiles it.
	PlaceConversation(ctx context.Context, owner, convID, folderID string) error
	// Unstar unfiles a conversation only from Starred.
	Unstar(ctx context.Context, owner, convID string) error
}

// FolderRoute matches /folders and /folders/<id>.
func FolderRoute(path string) (id string, ok bool) {
	parts := splitPath(path)
	switch {
	case len(parts) == 1 && parts[0] == "folders":
		return "", true
	case len(parts) == 2 && parts[0] == "folders":
		return parts[1], true
	}
	return "", false
}

// PlacementPut matches PUT /conversations/<id>/folder.
func PlacementPut(method, path string) (convID string, ok bool) {
	parts := splitPath(path)
	if method != http.MethodPut || len(parts) != 3 || parts[0] != "conversations" || parts[2] != "folder" {
		return "", false
	}
	return parts[1], true
}

// serveFolders serves the caller's /folders routes.
func serveFolders(w http.ResponseWriter, r *http.Request, id string, fs folderStore) {
	log := logger("folders")
	owner := ownerFrom(r)
	ctx := r.Context()
	var err error
	switch {
	case id == "" && r.Method == http.MethodGet:
		var list FolderList
		if list, err = fs.Folders(ctx, owner); err == nil {
			writeJSON(w, http.StatusOK, list)
			return
		}
	case id == "" && r.Method == http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		if decodeBody(r, &body) != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		name, msg := folderName(body.Name)
		if msg != "" {
			writeJSONError(w, http.StatusBadRequest, msg)
			return
		}
		var f Folder
		if f, err = fs.CreateFolder(ctx, owner, name); err == nil {
			writeJSON(w, http.StatusCreated, f)
			return
		}
	case id != "" && (r.Method == http.MethodPatch || r.Method == http.MethodDelete):
		if id == StarredFolderID {
			writeJSONError(w, http.StatusConflict, "Starred can't be renamed, moved or deleted")
			return
		}
		if r.Method == http.MethodDelete {
			err = fs.DeleteFolder(ctx, owner, id)
			break
		}
		var body FolderPatch
		if decodeBody(r, &body) != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if body.Name != nil {
			name, msg := folderName(*body.Name)
			if msg != "" {
				writeJSONError(w, http.StatusBadRequest, msg)
				return
			}
			body.Name = &name
		}
		if body.Icon != nil {
			icon, msg := folderIcon(*body.Icon)
			if msg != "" {
				writeJSONError(w, http.StatusBadRequest, msg)
				return
			}
			body.Icon = &icon
		}
		err = fs.UpdateFolder(ctx, owner, id, body)
	default:
		w.Header().Set("Allow", "GET, POST, PATCH, DELETE")
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, errFolderNameTaken):
		writeJSONError(w, http.StatusConflict, "you already have a folder with that name")
	case errors.Is(err, errFolderNotFound):
		writeJSONError(w, http.StatusNotFound, "not found")
	default:
		log.Error("folder request failed", slog.String("method", r.Method), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not update folders")
	}
}

// folderName trims a name, or returns why it is unusable.
func folderName(raw string) (string, string) {
	name := strings.TrimSpace(raw)
	switch {
	case name == "":
		return "", "name is required"
	case len([]rune(name)) > maxFolderName:
		return "", "name too long (max 100)"
	case strings.EqualFold(name, "starred"):
		return "", "Starred is the built-in folder"
	}
	return name, ""
}

// folderIcon validates a Lucide icon name, or says why not.
func folderIcon(raw string) (string, string) {
	icon := strings.TrimSpace(raw)
	if len(icon) > maxFolderIcon || !iconName.MatchString(icon) {
		return "", "icon must be a Lucide icon name, like \"briefcase\""
	}
	return icon, ""
}

// iconName is kebab-case, as Lucide names its icons.
var iconName = regexp.MustCompile(`^[a-z0-9-]*$`)

// servePlacement serves PUT …/folder and PATCH …/starred.
func servePlacement(w http.ResponseWriter, r *http.Request, convID string, store metaReader, fs folderStore) {
	log := logger("folders")
	owner := ownerFrom(r)
	starPatch := r.Method == http.MethodPatch
	var folderID string
	var starred bool
	if starPatch {
		var body struct {
			Starred *bool `json:"starred"`
		}
		if decodeBody(r, &body) != nil || body.Starred == nil {
			writeJSONError(w, http.StatusBadRequest, "starred (boolean) is required")
			return
		}
		starred = *body.Starred
		if starred {
			folderID = StarredFolderID
		}
	} else {
		var body struct {
			FolderID *string `json:"folderId"`
		}
		if decodeBody(r, &body) != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if body.FolderID != nil {
			folderID = *body.FolderID
		}
	}

	row, err := store.ConversationByID(r.Context(), convID)
	if err != nil {
		log.Error("placement: conversation read failed", convAttr(convID), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not read conversation")
		return
	}
	// A private conversation the caller can't see is missing.
	if row == nil || !canAccess(row.Owner, row.Visibility, owner) {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	if row.ParentID != nil {
		writeJSONError(w, http.StatusConflict, "a subagent stays under its parent")
		return
	}

	if starPatch && !starred {
		err = fs.Unstar(r.Context(), owner, convID)
	} else {
		err = fs.PlaceConversation(r.Context(), owner, convID, folderID)
	}
	switch {
	case errors.Is(err, errFolderNotFound):
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	case err != nil:
		log.Error("placement write failed", convAttr(convID), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not file conversation")
		return
	}
	if !starPatch {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// The star shortcut answers with the list row.
	out := makeListRow(*row, nil, time.Now().UnixMilli())
	out.Starred = starred
	writeJSON(w, http.StatusOK, out)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// runFolderListener tells an owner's list streams to refetch folders.
func runFolderListener(ctx context.Context, store *Store, hub *sseHub) {
	if store == nil {
		return
	}
	frame := sseData([]byte(`{"kind":"folders"}`))
	listenLoop(ctx, logger("folders-listen"), foldersChannel, store.NewListenConn, func(payload string) {
		if owner, ok := folderNotifyOwner(payload); ok {
			hub.deliver(frame, func(s *sseSub) bool { return s.callerOwner == owner })
		}
	})
}

// folderNotifyOwner parses a payload; "" is the anonymous owner.
func folderNotifyOwner(payload string) (string, bool) {
	var c struct {
		Owner *string `json:"owner"`
	}
	if err := json.Unmarshal([]byte(payload), &c); err != nil || c.Owner == nil {
		return "", false
	}
	return *c.Owner, true
}

// Folders reads the caller's folders and visible placements.
func (s *WriteStore) Folders(ctx context.Context, owner string) (FolderList, error) {
	out := FolderList{
		Folders:    []Folder{{ID: StarredFolderID, Name: "Starred", Kind: "starred"}},
		Placements: map[string]string{},
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, COALESCE(icon, ''), position FROM conversation_folders
		WHERE owner = $1 AND kind = 'user' ORDER BY position, created_at`, owner)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		f := Folder{Kind: "user"}
		if err := rows.Scan(&f.ID, &f.Name, &f.Icon, &f.Position); err != nil {
			rows.Close()
			return out, err
		}
		out.Folders = append(out.Folders, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows, err = s.pool.Query(ctx, `
		SELECT p.conversation_id, CASE WHEN f.kind = 'starred' THEN $2 ELSE f.id END
		FROM user_conversation_metadata p
		JOIN conversation_folders f ON f.id = p.folder_id
		JOIN conversations c ON c.id = p.conversation_id
		WHERE p.owner = $1 AND (c.visibility <> 'private' OR c.owner = $1)`, owner, StarredFolderID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var conv, folder string
		if err := rows.Scan(&conv, &folder); err != nil {
			return out, err
		}
		out.Placements[conv] = folder
	}
	return out, rows.Err()
}

// CreateFolder appends a user folder after the caller's last one.
func (s *WriteStore) CreateFolder(ctx context.Context, owner, name string) (Folder, error) {
	f := Folder{ID: uuid.NewString(), Name: name, Kind: "user"}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO conversation_folders (id, owner, kind, name, position, created_at)
		SELECT $1, $2, 'user', $3,
		       COALESCE((SELECT max(position) FROM conversation_folders WHERE owner = $2 AND kind = 'user'), 0) + 1, $4
		RETURNING position`, f.ID, owner, name, time.Now().UnixMilli()).Scan(&f.Position)
	return f, folderErr(err)
}

// UpdateFolder applies a patch to a user folder.
func (s *WriteStore) UpdateFolder(ctx context.Context, owner, id string, p FolderPatch) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE conversation_folders SET name = COALESCE($3, name), position = COALESCE($4, position),
		       icon = CASE WHEN $5::text IS NULL THEN icon ELSE NULLIF($5, '') END
		WHERE id = $1 AND owner = $2 AND kind = 'user'`, id, owner, p.Name, p.Position, p.Icon)
	if err == nil && tag.RowsAffected() == 0 {
		return errFolderNotFound
	}
	return folderErr(err)
}

// DeleteFolder removes a folder; its conversations return to Recent.
func (s *WriteStore) DeleteFolder(ctx context.Context, owner, id string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM conversation_folders WHERE id = $1 AND owner = $2 AND kind = 'user'`, id, owner)
	if err == nil && tag.RowsAffected() == 0 {
		return errFolderNotFound
	}
	return err
}

// PlaceConversation files convID, replacing any earlier placement.
func (s *WriteStore) PlaceConversation(ctx context.Context, owner, convID, folderID string) error {
	if folderID == StarredFolderID {
		id, err := s.ensureStarred(ctx, owner)
		if err != nil {
			return err
		}
		folderID = id
	}
	return s.placementTx(ctx, convID, func(tx pgx.Tx) error {
		if folderID == "" {
			_, err := tx.Exec(ctx,
				`DELETE FROM user_conversation_metadata WHERE owner = $1 AND conversation_id = $2`, owner, convID)
			return err
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO user_conversation_metadata (owner, conversation_id, folder_id)
			SELECT $1, $2, id FROM conversation_folders WHERE id = $3 AND owner = $1
			ON CONFLICT (owner, conversation_id) DO UPDATE SET folder_id = EXCLUDED.folder_id`,
			owner, convID, folderID)
		if err == nil && tag.RowsAffected() == 0 {
			return errFolderNotFound
		}
		return err
	})
}

// Unstar removes convID from Starred only.
func (s *WriteStore) Unstar(ctx context.Context, owner, convID string) error {
	return s.placementTx(ctx, convID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			DELETE FROM user_conversation_metadata p USING conversation_folders f
			WHERE p.owner = $1 AND p.conversation_id = $2 AND f.id = p.folder_id AND f.kind = 'starred'`,
			owner, convID)
		return err
	})
}

// placementTx also re-derives agent-host's delete guard, conversations.starred.
func (s *WriteStore) placementTx(ctx context.Context, convID string, change func(pgx.Tx) error) error {
	return folderErr(pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := change(tx); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE conversations c SET starred = EXISTS (
			  SELECT 1 FROM user_conversation_metadata p JOIN conversation_folders f ON f.id = p.folder_id
			  WHERE p.conversation_id = c.id AND f.kind = 'starred'
			    AND (c.owner IS NULL OR p.owner = c.owner OR p.owner = ''))
			WHERE c.id = $1`, convID)
		return err
	}))
}

// ensureStarred returns the Starred row id, creating it.
func (s *WriteStore) ensureStarred(ctx context.Context, owner string) (string, error) {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO conversation_folders (id, owner, kind, name, position, created_at)
		VALUES ($1, $2, 'starred', 'Starred', 0, $3)
		ON CONFLICT (owner) WHERE kind = 'starred' DO NOTHING`,
		uuid.NewString(), owner, time.Now().UnixMilli())
	if err != nil {
		return "", err
	}
	var id string
	err = s.pool.QueryRow(ctx,
		`SELECT id FROM conversation_folders WHERE owner = $1 AND kind = 'starred'`, owner).Scan(&id)
	return id, err
}

// folderErr maps constraint failures to sentinel errors.
func folderErr(err error) error {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		if errors.Is(err, pgx.ErrNoRows) {
			return errFolderNotFound
		}
		return err
	}
	switch pg.Code {
	case "23505": // unique_violation: the per-owner name index
		return errFolderNameTaken
	case "23503": // foreign_key_violation: the conversation was deleted
		return errFolderNotFound
	}
	return err
}
