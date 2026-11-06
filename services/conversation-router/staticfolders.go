package main

// Static folders: every user sees them; allowlisted services manage them.

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/chadac-me/scooter/conversation-router/svcauth"
)

// StaticFolder is a /static-folders entry.
type StaticFolder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Icon string `json:"icon,omitempty"`
	// ConversationLifetimeHours: 0 keeps conversations; nil uses the default.
	ConversationLifetimeHours *int `json:"conversationLifetimeHours,omitempty"`
}

// errStaticTaken: another service registered that id.
var errStaticTaken = errors.New("static folder belongs to another service")

// staticID matches the static_folders.id check.
var staticID = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

// ServiceCaller proves a service bearer, returning its account.
type ServiceCaller func(ctx context.Context, r *http.Request) (string, bool)

// staticFolderStore is satisfied by *WriteStore.
type staticFolderStore interface {
	StaticFolders(ctx context.Context) ([]StaticFolder, error)
	PutStaticFolder(ctx context.Context, account string, f StaticFolder) error
	DeleteStaticFolder(ctx context.Context, account, id string) error
}

// StaticFolderRoute matches /static-folders and /static-folders/<id>.
func StaticFolderRoute(path string) (id string, ok bool) {
	parts := splitPath(path)
	switch {
	case len(parts) == 1 && parts[0] == "static-folders":
		return "", true
	case len(parts) == 2 && parts[0] == "static-folders":
		return parts[1], true
	}
	return "", false
}

// serveStaticFolders lists, registers or removes a service's static folders.
func serveStaticFolders(w http.ResponseWriter, r *http.Request, id string, caller ServiceCaller, fs staticFolderStore) {
	log := logger("static-folders")
	account, ok := "", false
	if caller != nil {
		account, ok = caller(r.Context(), r)
	}
	if !ok {
		writeJSONError(w, http.StatusForbidden, "only an allowlisted service may manage static folders")
		return
	}
	ctx := r.Context()
	var err error
	switch {
	case id == "" && r.Method == http.MethodGet:
		var list []StaticFolder
		if list, err = fs.StaticFolders(ctx); err == nil {
			writeJSON(w, http.StatusOK, map[string]any{"folders": list})
			return
		}
	case id != "" && r.Method == http.MethodPut:
		var f StaticFolder
		if decodeBody(r, &f) != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		f.ID = id
		if msg := cleanStatic(&f); msg != "" {
			writeJSONError(w, http.StatusBadRequest, msg)
			return
		}
		err = fs.PutStaticFolder(ctx, account, f)
	case id != "" && r.Method == http.MethodDelete:
		err = fs.DeleteStaticFolder(ctx, account, id)
	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	switch {
	case err == nil:
		log.Info("static folder changed", slog.String("method", r.Method), slog.String("id", id),
			slog.String("service_account", account))
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, errStaticTaken):
		writeJSONError(w, http.StatusConflict, "another service registered that folder id")
	case errors.Is(err, errFolderNotFound):
		writeJSONError(w, http.StatusNotFound, "not found")
	default:
		log.Error("static folder request failed", slog.String("method", r.Method), errAttr(err))
		writeJSONError(w, http.StatusBadGateway, "could not update static folders")
	}
}

// cleanStatic normalizes a PUT body, or says why it's invalid.
func cleanStatic(f *StaticFolder) string {
	if !staticID.MatchString(f.ID) || f.ID == StarredFolderID {
		return "id must match " + staticID.String() + " and not be \"starred\""
	}
	name, msg := folderName(f.Name)
	if msg != "" {
		return msg
	}
	f.Name = name
	if f.Icon != "" {
		if f.Icon, msg = folderIcon(f.Icon); msg != "" {
			return msg
		}
	}
	if f.ConversationLifetimeHours != nil {
		return lifetimeMsg(*f.ConversationLifetimeHours)
	}
	return ""
}

// StaticFolders lists every static folder, oldest first.
func (s *WriteStore) StaticFolders(ctx context.Context) ([]StaticFolder, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, COALESCE(icon, ''), conversation_lifetime_hours
		FROM static_folders ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (StaticFolder, error) {
		var f StaticFolder
		err := row.Scan(&f.ID, &f.Name, &f.Icon, &f.ConversationLifetimeHours)
		return f, err
	})
}

// IsStatic reports whether id names a static folder.
func (s *WriteStore) IsStatic(ctx context.Context, id string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM static_folders WHERE id = $1)`, id).Scan(&ok)
	return ok, err
}

// PutStaticFolder creates or updates a folder that account owns.
func (s *WriteStore) PutStaticFolder(ctx context.Context, account string, f StaticFolder) error {
	return s.staticTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			INSERT INTO static_folders (id, service_account, name, icon, conversation_lifetime_hours, created_at)
			VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6)
			ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon,
			  conversation_lifetime_hours = EXCLUDED.conversation_lifetime_hours
			WHERE static_folders.service_account = EXCLUDED.service_account`,
			f.ID, account, f.Name, f.Icon, f.ConversationLifetimeHours, time.Now().UnixMilli())
		if err == nil && tag.RowsAffected() == 0 {
			return errStaticTaken
		}
		return err
	})
}

// DeleteStaticFolder removes account's folder; its conversations become unfiled.
func (s *WriteStore) DeleteStaticFolder(ctx context.Context, account, id string) error {
	return s.staticTx(ctx, func(tx pgx.Tx) error {
		var owner string
		err := tx.QueryRow(ctx, `SELECT service_account FROM static_folders WHERE id = $1`, id).Scan(&owner)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			return errFolderNotFound
		case err != nil:
			return err
		case owner != account:
			return errStaticTaken
		}
		_, err = tx.Exec(ctx, `DELETE FROM static_folders WHERE id = $1`, id)
		return err
	})
}

// staticTx runs change and tells every list stream to refetch folders.
func (s *WriteStore) staticTx(ctx context.Context, change func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := change(tx); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `SELECT pg_notify($1, '{"all":true}')`, foldersChannel)
		return err
	})
}

// staticFolderServiceAccounts is the allowlist of folder-managing services.
func staticFolderServiceAccounts() map[string]bool {
	return svcauth.ParseAllowlist(env("STATIC_FOLDER_SERVICE_ACCOUNTS", ""))
}

// newServiceCaller proves an allowlisted bearer; nil without an allowlist.
func newServiceCaller(review reviewTokenFunc, allowed map[string]bool) ServiceCaller {
	if len(allowed) == 0 || review == nil {
		return nil
	}
	verifier := svcauth.NewVerifier(review)
	policy := svcauth.Policy{Services: allowed}
	return func(ctx context.Context, r *http.Request) (string, bool) {
		if svcauth.BearerToken(r) == "" {
			return "", false
		}
		p, err := verifier.Resolve(ctx, r, policy)
		if err != nil {
			logger("static-folders").Warn("static folder caller refused",
				slog.String("username", p.ServiceAccount), errAttr(err))
			return "", false
		}
		return p.ServiceAccount, true
	}
}
