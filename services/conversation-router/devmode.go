// Kube-less DEV/E2E mode. In cluster the router learns conversation EXISTENCE + routing from a
// CRD watch and creates conversations by writing a Conversation CR. The local fast-e2e / dev stack
// has no apiserver and no controller — a single agent-host fronts a real Postgres. This file is the
// three seams that differ there:
//
//   - existence: allExisting (every metadata row is a real conversation — the store IS the
//     existence set, since nothing creates CRs);
//   - routing: a single AGENT_HOST_URL (the empty ownership cache always misses, so every route
//     falls through to this one upstream);
//   - create: a direct conversations-row INSERT (devCreator) instead of a CR write — agent-host
//     then hydrates the conversation from that row on the first /agui prompt, exactly as it would
//     after adopting a CR.
//
// None of this compiles into the production path's behaviour: it is reached only when
// ROUTER_DEV_MODE is set (see main.go).
package main

import (
	"context"
	"errors"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// crLookup answers conversation EXISTENCE + the CR fields the list join needs, keyed by id. Two
// implementations: the CRD watch cache (*OwnershipCache) in cluster, and allExisting in the
// kube-less stack. Passing the interface (rather than *OwnershipCache) into the list/events path is
// what lets the same assembleList/notify code serve both.
type crLookup interface {
	CR(id string) (CRInfo, bool)
}

// allExisting treats every conversation the metadata store knows as existing — the dev/e2e stack
// has no Conversation CRs, so the store is the whole existence set. Phase/sandbox are blank: there
// is one agent-host and no sandboxes, so the row's status is makeListRow's "running" default and
// the sandbox name is empty (both fields exist only to mirror the cluster projection).
type allExisting struct{}

func (allExisting) CR(id string) (CRInfo, bool) { return CRInfo{ID: id}, true }

// devModeEnabled reports whether to run the kube-less dev/e2e mode.
func devModeEnabled() bool {
	v := os.Getenv("ROUTER_DEV_MODE")
	return v == "1" || v == "true"
}

// agentHostURLFromEnv parses AGENT_HOST_URL — the single agent-host every dev-mode request proxies
// to. It is the fallback upstream (the empty cache never resolves an owner IP), so it must be an
// absolute URL.
func agentHostURLFromEnv() (*url.URL, error) {
	raw := os.Getenv("AGENT_HOST_URL")
	if raw == "" {
		return nil, errors.New("ROUTER_DEV_MODE needs AGENT_HOST_URL (the single agent-host to proxy to)")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "" || u.Host == "" {
		return nil, errors.New("AGENT_HOST_URL must be absolute, e.g. http://127.0.0.1:8079")
	}
	return u, nil
}

// devCreator is the kube-less create path: it inserts the conversations row directly rather than
// writing a Conversation CR (there is no apiserver). agent-host hydrates the conversation from that
// row on the first prompt (hydrateByThread), so create-then-prompt works with no controller. It
// holds its OWN writable pool — the read Store is pinned read-only, and a router NEVER writes in
// production, so this writer is fenced behind ROUTER_DEV_MODE and lives nowhere near that path.
type devCreator struct {
	pool *pgxpool.Pool
}

// OpenDevCreator opens the small writable pool for dev-mode creates. dsn is the same agent_host DSN
// the read store uses (in dev it is a superuser/trust role, so it can write).
func OpenDevCreator(ctx context.Context, dsn string) (*devCreator, error) {
	if dsn == "" {
		return nil, errors.New("ROUTER_DEV_MODE needs a writable AGENT_HOST_DB DSN (set AGENT_HOST_DB_DSN)")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	cfg.MinConns = 0
	cfg.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &devCreator{pool: pool}, nil
}

func (d *devCreator) Close() {
	if d != nil && d.pool != nil {
		d.pool.Close()
	}
}

// Create inserts a fresh conversations row. thread_id == id by construction (create.go mints one id
// that is both). title is usually "" (the agent's <title> or a rename fills it later), but an
// API-seeded create MAY carry one (create.go puts it in the spec; the cluster CRD prunes it, dev
// persists it) — an unprompted seed must still list with its title. ON CONFLICT DO NOTHING keeps a
// ret/double-create idempotent. The INSERT fires the conversations_changed trigger, so the router's
// own LISTEN loop pushes the new row to the sidebar.
func (d *devCreator) Create(ctx context.Context, name string, spec map[string]interface{}) error {
	id, now, title, model, owner, parent := devRowArgs(name, spec, time.Now().UnixMilli())
	_, err := d.pool.Exec(ctx, `
		INSERT INTO conversations
		  (id, thread_id, title, created_at, last_activity_at, model, owner, parent_id)
		VALUES ($1, $1, $2, $3, $3, $4, $5, $6)
		ON CONFLICT (id) DO NOTHING`,
		id, title, now, model, owner, parent)
	return err
}

// devRowArgs projects a create spec into the conversations-row columns. Pure, so the spec→column
// mapping (which spec keys become which columns) is unit-testable without a database. title is a
// plain string (the column is NOT NULL — absent becomes "", not NULL); the nullable columns use
// specString.
func devRowArgs(id string, spec map[string]interface{}, now int64) (rowID string, createdAt int64, title string, model, owner, parent *string) {
	return id, now, specPlain(spec, "title"), specString(spec, "model"), specString(spec, "owner"), specString(spec, "parentId")
}

// specString reads a string spec value, treating "" and a non-string as absent (a NULL column).
func specString(spec map[string]interface{}, k string) *string {
	if v, ok := spec[k].(string); ok && v != "" {
		return &v
	}
	return nil
}

// specPlain reads a string spec value for a NOT NULL column — absent / non-string becomes "".
func specPlain(spec map[string]interface{}, k string) string {
	if v, ok := spec[k].(string); ok {
		return v
	}
	return ""
}
