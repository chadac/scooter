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

// foldersChannel carries each folder change's owner.
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
)

// Folder is a GET /folders entry; static folders list first.
type Folder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Icon string `json:"icon,omitempty"`
	Kind string `json:"kind"`
	// Static folders are fixed: no rename, move, delete or subfolders.
	Static bool `json:"static,omitempty"`
	// ParentID is the enclosing folder; empty at the top level.
	ParentID string  `json:"parentId,omitempty"`
	Position float64 `json:"position"`
	// LifetimeHours: idle hours before deletion; 0 forever, nil inherits.
	LifetimeHours *int `json:"lifetimeHours,omitempty"`
}

// StaticFolder is one deployment-configured folder, from STATIC_FOLDERS_JSON.
type StaticFolder struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Icon          string `json:"icon,omitempty"`
	LifetimeHours *int   `json:"lifetimeHours,omitempty"`
}

// FolderPatch is a PATCH body: nil keeps a field, "" clears Icon.
type FolderPatch struct {
	Name     *string  `json:"name"`
	Icon     *string  `json:"icon"`
	Position *float64 `json:"position"`
	// ParentID moves the folder; "" is the top level.
	ParentID *string `json:"parentId"`
	// LifetimeHours set to null inherits again.
	LifetimeHours optionalInt `json:"lifetimeHours"`
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
	CreateFolder(ctx context.Context, owner, name, parentID string) (Folder, error)
	UpdateFolder(ctx context.Context, owner, id string, p FolderPatch) error
	// DeleteFolder lifts its contents a level, or drops subfolders too.
	DeleteFolder(ctx context.Context, owner, id string, subfolders bool) error
	// PlaceConversation files a conversation; folderID "" unfiles it.
	PlaceConversation(ctx context.Context, owner, convID, folderID string) error
	// Unstar unfiles a conversation only from Starred.
	Unstar(ctx context.Context, owner, convID string) error
	// IsStatic reports a configured static folder's wire id.
	IsStatic(id string) bool
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
			Name     string `json:"name"`
			ParentID string `json:"parentId"`
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
		if f, err = fs.CreateFolder(ctx, owner, name, body.ParentID); err == nil {
			writeJSON(w, http.StatusCreated, f)
			return
		}
	case id != "" && (r.Method == http.MethodPatch || r.Method == http.MethodDelete):
		if id == StarredFolderID || fs.IsStatic(id) {
			writeJSONError(w, http.StatusConflict, "static folders can't be renamed, moved or deleted")
			return
		}
		if r.Method == http.MethodDelete {
			err = fs.DeleteFolder(ctx, owner, id, r.URL.Query().Get("subfolders") == "delete")
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
		writeJSONError(w, http.StatusConflict, "you already have a folder with that name there")
	case errors.Is(err, errFolderTooDeep):
		writeJSONError(w, http.StatusConflict, fmt.Sprintf("folders nest at most %d deep", MaxFolderDepth))
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
	if p.LifetimeHours.Value != nil {
		return lifetimeMsg(*p.LifetimeHours.Value)
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
		return fmt.Sprintf("lifetimeHours must be 0 (forever) to %d", maxLifetimeHours)
	}
	return ""
}

// iconName is kebab-case, as Lucide names its icons.
var iconName = regexp.MustCompile(`^[a-z0-9-]*$`)

// staticID matches the conversation_folders.static_id check.
var staticID = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

// parseStaticFolders reads STATIC_FOLDERS_JSON; "" means none.
func parseStaticFolders(raw string) ([]StaticFolder, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var out []StaticFolder
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, err
	}
	seen := map[string]bool{StarredFolderID: true}
	for i, f := range out {
		name, msg := folderName(f.Name)
		if msg == "" && f.Icon != "" {
			_, msg = folderIcon(f.Icon)
		}
		if msg == "" && f.LifetimeHours != nil {
			msg = lifetimeMsg(*f.LifetimeHours)
		}
		switch {
		case !staticID.MatchString(f.ID):
			return nil, fmt.Errorf("static folder %q: id must match %s", f.ID, staticID)
		case seen[f.ID]:
			return nil, fmt.Errorf("static folder %q: id is taken", f.ID)
		case msg != "":
			return nil, fmt.Errorf("static folder %q: %s", f.ID, msg)
		}
		seen[f.ID] = true
		out[i].Name = name
	}
	return out, nil
}

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

// IsStatic reports whether id names a configured static folder.
func (s *WriteStore) IsStatic(id string) bool {
	_, ok := s.static(id)
	return ok
}

func (s *WriteStore) static(id string) (StaticFolder, bool) {
	for _, f := range s.statics {
		if f.ID == id {
			return f, true
		}
	}
	return StaticFolder{}, false
}

func (s *WriteStore) staticIDs() []string {
	ids := make([]string, 0, len(s.statics))
	for _, f := range s.statics {
		ids = append(ids, f.ID)
	}
	return ids
}

// SyncStaticFolders copies configured lifetimes to rows, for agent-host's reap.
func (s *WriteStore) SyncStaticFolders(ctx context.Context) error {
	for _, f := range s.statics {
		// Skips unchanged rows, so a boot notifies nobody.
		_, err := s.pool.Exec(ctx, `
			UPDATE conversation_folders SET lifetime_hours = $2
			WHERE kind = 'static' AND static_id = $1 AND lifetime_hours IS DISTINCT FROM $2::int`,
			f.ID, f.LifetimeHours)
		if err != nil {
			return err
		}
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE conversation_folders SET lifetime_hours = NULL
		WHERE kind = 'static' AND NOT (static_id = ANY($1)) AND lifetime_hours IS NOT NULL`, s.staticIDs())
	return err
}

// Folders reads the caller's folders and visible placements.
func (s *WriteStore) Folders(ctx context.Context, owner string) (FolderList, error) {
	forever := 0
	out := FolderList{
		Folders:    []Folder{{ID: StarredFolderID, Name: "Starred", Kind: "starred", Static: true, LifetimeHours: &forever}},
		Placements: map[string]string{},
	}
	for i, f := range s.statics {
		out.Folders = append(out.Folders, Folder{
			ID: f.ID, Name: f.Name, Icon: f.Icon, Kind: "static", Static: true,
			Position: float64(i + 1), LifetimeHours: f.LifetimeHours,
		})
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, COALESCE(icon, ''), COALESCE(parent_id, ''), lifetime_hours, position
		FROM conversation_folders
		WHERE owner = $1 AND kind = 'user' ORDER BY position, created_at`, owner)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		f := Folder{Kind: "user"}
		if err := rows.Scan(&f.ID, &f.Name, &f.Icon, &f.ParentID, &f.LifetimeHours, &f.Position); err != nil {
			rows.Close()
			return out, err
		}
		out.Folders = append(out.Folders, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	// Unconfigured static folders drop out; their conversations show unfiled.
	rows, err = s.pool.Query(ctx, `
		SELECT p.conversation_id,
		       CASE f.kind WHEN 'starred' THEN $2 WHEN 'static' THEN f.static_id ELSE f.id END
		FROM user_conversation_metadata p
		JOIN conversation_folders f ON f.id = p.folder_id
		JOIN conversations c ON c.id = p.conversation_id
		WHERE p.owner = $1 AND (c.visibility <> 'private' OR c.owner = $1)
		  AND (f.kind <> 'static' OR f.static_id = ANY($3))`, owner, StarredFolderID, s.staticIDs())
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
func (s *WriteStore) CreateFolder(ctx context.Context, owner, name, parentID string) (Folder, error) {
	f := Folder{ID: uuid.NewString(), Name: name, Kind: "user", ParentID: parentID}
	err := s.folderTx(ctx, owner, func(tx pgx.Tx) error {
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
			INSERT INTO conversation_folders (id, owner, kind, parent_id, name, position, created_at)
			VALUES ($1, $2, 'user', NULLIF($3, ''), $4, $5, $6)`,
			f.ID, owner, parentID, name, pos, time.Now().UnixMilli())
		return err
	})
	return f, err
}

// UpdateFolder applies a patch to a user folder, checking any move.
func (s *WriteStore) UpdateFolder(ctx context.Context, owner, id string, p FolderPatch) error {
	return s.folderTx(ctx, owner, func(tx pgx.Tx) error {
		if p.ParentID != nil {
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
			       lifetime_hours = CASE WHEN $7 THEN $8::int ELSE lifetime_hours END
			WHERE id = $1 AND owner = $2 AND kind = 'user'`,
			id, owner, p.Name, p.Position, p.Icon, p.ParentID, p.LifetimeHours.Set, p.LifetimeHours.Value)
		if err == nil && tag.RowsAffected() == 0 {
			return errFolderNotFound
		}
		return err
	})
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
func (s *WriteStore) DeleteFolder(ctx context.Context, owner, id string, subfolders bool) error {
	return s.folderTx(ctx, owner, func(tx pgx.Tx) error {
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
	} else if f, ok := s.static(folderID); ok {
		id, err := s.ensureStatic(ctx, owner, f)
		if err != nil {
			return err
		}
		folderID, kind = id, "static"
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

// ensureStatic returns the owner's row for a static folder, creating it.
func (s *WriteStore) ensureStatic(ctx context.Context, owner string, f StaticFolder) (string, error) {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO conversation_folders (id, owner, kind, static_id, name, icon, lifetime_hours, position, created_at)
		VALUES ($1, $2, 'static', $3, $4, NULLIF($5, ''), $6, 0, $7)
		ON CONFLICT (owner, static_id) WHERE kind = 'static' DO NOTHING`,
		uuid.NewString(), owner, f.ID, f.Name, f.Icon, f.LifetimeHours, time.Now().UnixMilli())
	if err != nil {
		return "", err
	}
	var id string
	err = s.pool.QueryRow(ctx,
		`SELECT id FROM conversation_folders WHERE owner = $1 AND kind = 'static' AND static_id = $2`,
		owner, f.ID).Scan(&id)
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
