// Per-user sidebar folders and stars, served without any pod.
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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// StarredFolderID is the wire id of every user's built-in Starred folder.
const StarredFolderID = "starred"

// foldersChannel carries each folder change's owner, and folder services' events.
const foldersChannel = "conversation_folders_changed"

const (
	maxFolderName = 100
	maxFolderIcon = 40
	// MaxFolderDepth caps nesting; a top-level folder is depth 1.
	MaxFolderDepth = 3
	// maxLifetimeHours is ten years, well past any real retention.
	maxLifetimeHours = 10 * 365 * 24
	// folderLockClass namespaces the per-owner advisory lock.
	folderLockClass = 7301
)

var (
	errFolderNameTaken = errors.New("folder name taken")
	errFolderNotFound  = errors.New("folder not found")
	errFolderTooDeep   = errors.New("folder nesting too deep")
	errFolderCycle     = errors.New("folder moved inside itself")
	errFolderLocked    = errors.New("folder is locked")
	errLockedParent    = errors.New("locked folder outside a locked parent")
)

// Folder is a GET /folders entry; Starred lists first.
type Folder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Icon string `json:"icon,omitempty"`
	Kind string `json:"kind"`
	// Locked: only a folder service changes it; users file conversations.
	Locked bool `json:"locked,omitempty"`
	// ParentID is the enclosing folder; empty at the top level.
	ParentID string  `json:"parentId,omitempty"`
	Position float64 `json:"position"`
	// ConversationLifetimeHours: idle hours before deletion; 0 forever, nil inherits.
	ConversationLifetimeHours *int `json:"conversationLifetimeHours,omitempty"`
}

// FolderPatch is a PATCH body: nil keeps a field, "" clears Icon.
type FolderPatch struct {
	Name     *string  `json:"name"`
	Icon     *string  `json:"icon"`
	Position *float64 `json:"position"`
	// ParentID moves the folder; "" is the top level.
	ParentID *string `json:"parentId"`
	// ConversationLifetimeHours set to null inherits again.
	ConversationLifetimeHours optionalInt `json:"conversationLifetimeHours"`
}

// optionalInt tells an explicit null apart from an absent field.
type optionalInt struct {
	Set   bool
	Value *int
}

func (o *optionalInt) UnmarshalJSON(b []byte) error {
	o.Set = true
	return json.Unmarshal(b, &o.Value)
}

// FolderList is the GET /folders body.
type FolderList struct {
	Folders    []Folder          `json:"folders"`
	Placements map[string]string `json:"placements"`
}

// folderStore is the narrow store dep, satisfied by *WriteStore.
type folderStore interface {
	Folders(ctx context.Context, owner string) (FolderList, error)
	// CreateFolder nests in parentID; "" is the top level.
	// service: the caller is a folder service, allowed locked folders.
	CreateFolder(ctx context.Context, owner, name, parentID string, locked, service bool) (Folder, error)
	UpdateFolder(ctx context.Context, owner, id string, p FolderPatch, service bool) error
	// DeleteFolder lifts its contents a level, or drops subfolders too.
	DeleteFolder(ctx context.Context, owner, id string, subfolders, service bool) error
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
func serveFolders(w http.ResponseWriter, r *http.Request, id string, fs folderStore, services FolderService) {
	log := logger("folders")
	ctx := r.Context()
	owner, service := folderCaller(r, services)
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
			Name     string `json:"name"`
			ParentID string `json:"parentId"`
			Locked   bool   `json:"locked"`
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
		if body.Locked && !service {
			writeJSONError(w, http.StatusForbidden, "only a folder service can create a locked folder")
			return
		}
		var f Folder
		if f, err = fs.CreateFolder(ctx, owner, name, body.ParentID, body.Locked, service); err == nil {
			writeJSON(w, http.StatusCreated, f)
			return
		}
	case id != "" && (r.Method == http.MethodPatch || r.Method == http.MethodDelete):
		if id == StarredFolderID {
			writeJSONError(w, http.StatusConflict, "Starred can't be renamed, moved or deleted")
			return
		}
		if r.Method == http.MethodDelete {
			err = fs.DeleteFolder(ctx, owner, id, r.URL.Query().Get("subfolders") == "delete", service)
			break
		}
		var body FolderPatch
		if decodeBody(r, &body) != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if msg := cleanPatch(&body); msg != "" {
			writeJSONError(w, http.StatusBadRequest, msg)
			return
		}
		err = fs.UpdateFolder(ctx, owner, id, body, service)
	default:
		w.Header().Set("Allow", "GET, POST, PATCH, DELETE")
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, errFolderNameTaken):
		writeJSONError(w, http.StatusConflict, "you already have a folder with that name there")
	case errors.Is(err, errFolderTooDeep):
		writeJSONError(w, http.StatusConflict, fmt.Sprintf("folders nest at most %d deep", MaxFolderDepth))
	case errors.Is(err, errFolderLocked):
		writeJSONError(w, http.StatusConflict, "this folder is locked; only its service can change it")
	case errors.Is(err, errLockedParent):
		writeJSONError(w, http.StatusConflict, "a locked folder goes at the top level or in a locked folder")
	case errors.Is(err, errFolderCycle):
		writeJSONError(w, http.StatusConflict, "a folder can't go inside itself")
	case errors.Is(err, errFolderNotFound):
		writeJSONError(w, http.StatusNotFound, "not found")
	default:
		log.Error("folder request failed", slog.String("method", r.Method), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not update folders")
	}
}

// cleanPatch normalizes a patch, or says why it's invalid.
func cleanPatch(p *FolderPatch) string {
	if p.Name != nil {
		name, msg := folderName(*p.Name)
		if msg != "" {
			return msg
		}
		p.Name = &name
	}
	if p.Icon != nil {
		icon, msg := folderIcon(*p.Icon)
		if msg != "" {
			return msg
		}
		p.Icon = &icon
	}
	if p.ConversationLifetimeHours.Value != nil {
		return lifetimeMsg(*p.ConversationLifetimeHours.Value)
	}
	return ""
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

// lifetimeMsg says why a lifetime is out of range, or "".
func lifetimeMsg(h int) string {
	if h < 0 || h > maxLifetimeHours {
		return fmt.Sprintf("conversationLifetimeHours must be 0 (forever) to %d", maxLifetimeHours)
	}
	return ""
}

// iconName is kebab-case, as Lucide names its icons.
var iconName = regexp.MustCompile(`^[a-z0-9-]*$`)

// folderCaller returns the acting user and whether a service named them.
func folderCaller(r *http.Request, services FolderService) (owner string, service bool) {
	if services != nil && bearerToken(r) != "" {
		if user, ok := services(r.Context(), r); ok {
			return user, true
		}
	}
	return ownerFrom(r), false
}

// servePlacement serves PUT …/folder and PATCH …/starred.
func servePlacement(w http.ResponseWriter, r *http.Request, convID string, store metaReader, fs folderStore, services FolderService) {
	log := logger("folders")
	owner, _ := folderCaller(r, services)
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

// runFolderListener pushes folder and contrib changes to their owner's streams.
func runFolderListener(ctx context.Context, store *Store, hub *sseHub) {
	if store == nil {
		return
	}
	listenLoop(ctx, logger("folders-listen"), foldersChannel, store.NewListenConn, func(payload string) {
		if owner, frame, ok := folderNotify(payload); ok {
			hub.deliver(sseData(frame), func(s *sseSub) bool { return s.callerOwner == owner })
		}
	})
}

// Folders reads the caller's folders and visible placements.
func (s *WriteStore) Folders(ctx context.Context, owner string) (FolderList, error) {
	forever := 0
	out := FolderList{
		Folders:    []Folder{{ID: StarredFolderID, Name: "Starred", Kind: "starred", Locked: true, ConversationLifetimeHours: &forever}},
		Placements: map[string]string{},
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, COALESCE(icon, ''), COALESCE(parent_id, ''), locked, conversation_lifetime_hours, position
		FROM conversation_folders
		WHERE owner = $1 AND kind = 'user' ORDER BY position, created_at`, owner)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		f := Folder{Kind: "user"}
		if err := rows.Scan(&f.ID, &f.Name, &f.Icon, &f.ParentID, &f.Locked, &f.ConversationLifetimeHours, &f.Position); err != nil {
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
		SELECT p.conversation_id,
		       CASE f.kind WHEN 'starred' THEN $2 ELSE f.id END
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

// folderTx holds the owner's folder lock, so moves can't race.
func (s *WriteStore) folderTx(ctx context.Context, owner string, change func(pgx.Tx) error) error {
	return folderErr(pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, folderLockClass, owner); err != nil {
			return err
		}
		return change(tx)
	}))
}

// folderDepth is a user folder's level, 1 at the top.
func folderDepth(ctx context.Context, tx pgx.Tx, owner, id string) (int, error) {
	var depth *int
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE up AS (
		  SELECT parent_id, 1 AS n FROM conversation_folders WHERE id = $1 AND owner = $2 AND kind = 'user'
		  UNION ALL
		  SELECT f.parent_id, up.n + 1 FROM up JOIN conversation_folders f ON f.id = up.parent_id
		  WHERE up.n <= $3
		)
		SELECT max(n) FROM up`, id, owner, MaxFolderDepth).Scan(&depth)
	if err == nil && depth == nil {
		return 0, errFolderNotFound
	}
	if depth == nil {
		return 0, err
	}
	return *depth, err
}

// nextPosition is one past the last sibling under parentID.
func nextPosition(ctx context.Context, tx pgx.Tx, owner, parentID string) (float64, error) {
	var pos float64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(max(position), 0) + 1 FROM conversation_folders
		WHERE owner = $1 AND kind = 'user' AND parent_id IS NOT DISTINCT FROM NULLIF($2, '')`,
		owner, parentID).Scan(&pos)
	return pos, err
}

// CreateFolder appends a user folder after its last sibling.
func (s *WriteStore) CreateFolder(ctx context.Context, owner, name, parentID string, locked, service bool) (Folder, error) {
	f := Folder{ID: uuid.NewString(), Name: name, Kind: "user", ParentID: parentID, Locked: locked}
	err := s.folderTx(ctx, owner, func(tx pgx.Tx) error {
		if err := checkParent(ctx, tx, owner, parentID, locked, service); err != nil {
			return err
		}
		if parentID != "" {
			depth, err := folderDepth(ctx, tx, owner, parentID)
			if err != nil {
				return err
			}
			if depth >= MaxFolderDepth {
				return errFolderTooDeep
			}
		}
		pos, err := nextPosition(ctx, tx, owner, parentID)
		if err != nil {
			return err
		}
		f.Position = pos
		_, err = tx.Exec(ctx, `
			INSERT INTO conversation_folders (id, owner, kind, parent_id, name, locked, position, created_at)
			VALUES ($1, $2, 'user', NULLIF($3, ''), $4, $5, $6, $7)`,
			f.ID, owner, parentID, name, locked, pos, time.Now().UnixMilli())
		return err
	})
	return f, err
}

// UpdateFolder applies a patch to a user folder, checking any move.
func (s *WriteStore) UpdateFolder(ctx context.Context, owner, id string, p FolderPatch, service bool) error {
	return s.folderTx(ctx, owner, func(tx pgx.Tx) error {
		locked, err := checkLock(ctx, tx, owner, id, service)
		if err != nil {
			return err
		}
		if p.ParentID != nil {
			if err := checkParent(ctx, tx, owner, *p.ParentID, locked, service); err != nil {
				return err
			}
			if err := checkMove(ctx, tx, owner, id, *p.ParentID); err != nil {
				return err
			}
			if p.Position == nil {
				pos, err := nextPosition(ctx, tx, owner, *p.ParentID)
				if err != nil {
					return err
				}
				p.Position = &pos
			}
		}
		tag, err := tx.Exec(ctx, `
			UPDATE conversation_folders SET name = COALESCE($3, name), position = COALESCE($4, position),
			       icon = CASE WHEN $5::text IS NULL THEN icon ELSE NULLIF($5, '') END,
			       parent_id = CASE WHEN $6::text IS NULL THEN parent_id ELSE NULLIF($6, '') END,
			       conversation_lifetime_hours = CASE WHEN $7 THEN $8::int ELSE conversation_lifetime_hours END
			WHERE id = $1 AND owner = $2 AND kind = 'user'`,
			id, owner, p.Name, p.Position, p.Icon, p.ParentID, p.ConversationLifetimeHours.Set, p.ConversationLifetimeHours.Value)
		if err == nil && tag.RowsAffected() == 0 {
			return errFolderNotFound
		}
		return err
	})
}

// checkLock reads a folder's lock, refusing users a locked one.
func checkLock(ctx context.Context, tx pgx.Tx, owner, id string, service bool) (bool, error) {
	var locked bool
	err := tx.QueryRow(ctx,
		`SELECT locked FROM conversation_folders WHERE id = $1 AND owner = $2 AND kind = 'user'`, id, owner).Scan(&locked)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return false, errFolderNotFound
	case err == nil && locked && !service:
		return locked, errFolderLocked
	}
	return locked, err
}

// checkParent keeps users out of locked parents, locked folders in.
func checkParent(ctx context.Context, tx pgx.Tx, owner, parentID string, locked, service bool) error {
	if parentID == "" {
		return nil
	}
	parentLocked, err := checkLock(ctx, tx, owner, parentID, service)
	if err == nil && locked && !parentLocked {
		return errLockedParent
	}
	return err
}

// checkMove refuses cycles and moves past the depth cap.
func checkMove(ctx context.Context, tx pgx.Tx, owner, id, parentID string) error {
	var height *int
	var cycle *bool
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE down AS (
		  SELECT id, 1 AS n FROM conversation_folders WHERE id = $1 AND owner = $2 AND kind = 'user'
		  UNION ALL
		  SELECT f.id, down.n + 1 FROM down JOIN conversation_folders f ON f.parent_id = down.id
		  WHERE down.n <= $4
		)
		SELECT max(n), bool_or(id = $3) FROM down`, id, owner, parentID, MaxFolderDepth).Scan(&height, &cycle)
	switch {
	case err != nil:
		return err
	case height == nil:
		return errFolderNotFound
	case *cycle:
		return errFolderCycle
	case parentID == "":
		return nil
	}
	depth, err := folderDepth(ctx, tx, owner, parentID)
	if err != nil {
		return err
	}
	if depth+*height > MaxFolderDepth {
		return errFolderTooDeep
	}
	return nil
}

// DeleteFolder lifts its contents a level, or drops the subtree.
func (s *WriteStore) DeleteFolder(ctx context.Context, owner, id string, subfolders, service bool) error {
	return s.folderTx(ctx, owner, func(tx pgx.Tx) error {
		if _, err := checkLock(ctx, tx, owner, id, service); err != nil {
			return err
		}
		var parent *string
		var pos float64
		err := tx.QueryRow(ctx, `
			SELECT parent_id, position FROM conversation_folders WHERE id = $1 AND owner = $2 AND kind = 'user'`,
			id, owner).Scan(&parent, &pos)
		if err != nil {
			return err
		}
		if !subfolders {
			if err := liftContents(ctx, tx, owner, id, parent, pos); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `DELETE FROM conversation_folders WHERE id = $1`, id)
		return err
	})
}

// liftContents moves a folder's conversations and subfolders into its place.
func liftContents(ctx context.Context, tx pgx.Tx, owner, id string, parent *string, pos float64) error {
	if parent != nil {
		if _, err := tx.Exec(ctx,
			`UPDATE user_conversation_metadata SET folder_id = $2 WHERE folder_id = $1`, id, *parent); err != nil {
			return err
		}
	}
	var next float64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(min(position), $3::float8 + 1) FROM conversation_folders
		WHERE owner = $1 AND kind = 'user' AND parent_id IS NOT DISTINCT FROM $2 AND position > $3`,
		owner, parent, pos).Scan(&next); err != nil {
		return err
	}
	// Free the name, so a child may reuse it.
	if _, err := tx.Exec(ctx, `UPDATE conversation_folders SET name = id WHERE id = $1`, id); err != nil {
		return err
	}
	// Children keep their order, between this folder and the next.
	_, err := tx.Exec(ctx, `
		UPDATE conversation_folders f SET parent_id = $2, position = $3::float8 + ($4::float8 - $3::float8) * o.rn / (o.cnt + 1)
		FROM (SELECT id, row_number() OVER (ORDER BY position, created_at) AS rn, count(*) OVER () AS cnt
		      FROM conversation_folders WHERE parent_id = $1) o
		WHERE f.id = o.id`, id, parent, pos, next)
	return err
}

// PlaceConversation files convID, replacing any earlier placement.
func (s *WriteStore) PlaceConversation(ctx context.Context, owner, convID, folderID string) error {
	kind := "user"
	if folderID == StarredFolderID {
		id, err := s.ensureStarred(ctx, owner)
		if err != nil {
			return err
		}
		folderID, kind = id, "starred"
	}
	return s.placementTx(ctx, convID, func(tx pgx.Tx) error {
		if folderID == "" {
			_, err := tx.Exec(ctx,
				`DELETE FROM user_conversation_metadata WHERE owner = $1 AND conversation_id = $2`, owner, convID)
			return err
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO user_conversation_metadata (owner, conversation_id, folder_id)
			SELECT $1, $2, id FROM conversation_folders WHERE id = $3 AND owner = $1 AND kind = $4
			ON CONFLICT (owner, conversation_id) DO UPDATE SET folder_id = EXCLUDED.folder_id`,
			owner, convID, folderID, kind)
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
	case "23505": // unique_violation: the per-parent name index
		return errFolderNameTaken
	case "23503": // foreign_key_violation: the conversation was deleted
		return errFolderNotFound
	}
	return err
}
