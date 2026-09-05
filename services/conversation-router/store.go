// Postgres access for the router: a read pool (Store, read-only for the list/LISTEN path) and a
// narrow write pool (WriteStore) for idle star/title writes. Read-only guarantee + why: PR #475.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ConversationRow is the durable metadata the sidebar list needs. It deliberately omits
// pending_queue (the queued-message blob) — the list never reads it, and leaving it out keeps
// this a projection, not a full mirror of the agent-host row.
type ConversationRow struct {
	ID             string
	ThreadID       string
	Title          string
	CreatedAt      int64
	LastActivityAt int64
	Model          *string
	Owner          *string
	ParentID       *string
	UserTitled     *bool
	Starred        *bool
}

// Store is a read-only handle on the agent_host database. nil when no DSN is configured
// (the router then runs exactly as before — DB access is additive, never required to proxy).
type Store struct {
	pool *pgxpool.Pool
	// connConfig is the parsed, read-only-pinned single-connection config. The LISTEN loop
	// (events.go) opens a DEDICATED connection from it rather than borrowing a pool conn: a
	// LISTEN holds its connection for the process lifetime, which would permanently starve the
	// tiny (MaxConns=4) request pool.
	connConfig *pgx.ConnConfig
}

// storeDSNFromEnv assembles the connection string for the agent_host database from the same
// AGENT_HOST_DB_* variables agent-host reads, EXCEPT the credentials name the router's
// read-only role. Prefers an explicit AGENT_HOST_DB_DSN. Returns "" when no password is set —
// the signal that DB access is not configured (dev / pg-less), NOT an error.
func storeDSNFromEnv() string {
	if dsn := os.Getenv("AGENT_HOST_DB_DSN"); dsn != "" {
		return dsn
	}
	pw := os.Getenv("AGENT_HOST_DB_PASSWORD")
	if pw == "" {
		return ""
	}
	host := envOr("AGENT_HOST_DB_HOST", "agent-shared-db")
	port := envOr("AGENT_HOST_DB_PORT", "5432")
	name := envOr("AGENT_HOST_DB_NAME", "agent_host")
	user := envOr("AGENT_HOST_DB_USER", "conversation_router")
	dsn := fmt.Sprintf("postgresql://%s:%s@%s:%s/%s",
		url.QueryEscape(user), url.QueryEscape(pw), host, port, name)
	if ssl := os.Getenv("AGENT_HOST_DB_SSLMODE"); ssl != "" {
		dsn += "?sslmode=" + url.QueryEscape(ssl)
	}
	return dsn
}

// buildPoolConfig parses dsn and pins the connection to read-only. Factored out so the
// read-only guard is unit-testable without a live database.
func buildPoolConfig(dsn string) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	// Client-side half of the read-only guarantee (the DB role is the other half). Applied to
	// every connection the pool opens, so nothing from this process can begin a writing txn.
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	// A proxy, not a batch worker: keep the footprint tiny and never block a request on the DB.
	cfg.MinConns = 0
	cfg.MaxConns = 4
	return cfg, nil
}

// OpenStore connects the read-only pool. The caller must Close it.
func OpenStore(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := buildPoolConfig(dsn)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool, connConfig: cfg.ConnConfig}, nil
}

// NewListenConn opens a DEDICATED (non-pool) read-only connection for the LISTEN loop. It carries
// the same default_transaction_read_only guard as the pool (LISTEN is permitted under it — the
// notification stream is not a transaction). The caller owns the connection and must Close it;
// the loop reconnects through here after a drop.
func (s *Store) NewListenConn(ctx context.Context) (*pgx.Conn, error) {
	return pgx.ConnectConfig(ctx, s.connConfig)
}

// CountConversations reads the conversations table — used at boot to VERIFY the SELECT grant
// actually works (a bad grant surfaces as an error here, not silently later).
func (s *Store) CountConversations(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, "SELECT count(*) FROM conversations").Scan(&n)
	return n, err
}

// Conversations returns every conversation's durable metadata, newest-active first — the row
// set the fleet-aggregate list is built from.
func (s *Store) Conversations(ctx context.Context) ([]ConversationRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, thread_id, title, created_at, last_activity_at,
		       model, owner, parent_id, user_titled, starred
		  FROM conversations
		 ORDER BY last_activity_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ConversationRow
	for rows.Next() {
		var c ConversationRow
		if err := rows.Scan(&c.ID, &c.ThreadID, &c.Title, &c.CreatedAt, &c.LastActivityAt,
			&c.Model, &c.Owner, &c.ParentID, &c.UserTitled, &c.Starred); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ConversationByID reads ONE conversation's durable metadata — the row the LISTEN loop re-reads on
// each notification to build an `upsert` frame (the NOTIFY payload carries only the id; the row is
// authoritative). Returns (nil, nil) when the row is gone — a delete that raced ahead of the read —
// so the caller simply emits nothing (the poll reconciles removals).
func (s *Store) ConversationByID(ctx context.Context, id string) (*ConversationRow, error) {
	var c ConversationRow
	err := s.pool.QueryRow(ctx, `
		SELECT id, thread_id, title, created_at, last_activity_at,
		       model, owner, parent_id, user_titled, starred
		  FROM conversations
		 WHERE id = $1`, id).Scan(&c.ID, &c.ThreadID, &c.Title, &c.CreatedAt, &c.LastActivityAt,
		&c.Model, &c.Owner, &c.ParentID, &c.UserTitled, &c.Starred)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// Close releases the pool. Safe on a nil Store (the not-configured case).
func (s *Store) Close() {
	if s != nil && s.pool != nil {
		s.pool.Close()
	}
}

// WriteStore is the router's narrow production write path to agent_host.conversations (title /
// starred / user_titled, idle conversations only). nil when no DSN is configured. Why: PR #475.
type WriteStore struct {
	pool *pgxpool.Pool
}

// buildWritePoolConfig pins the pool READ-WRITE, overriding the role's read-only default (a startup
// option outranks ALTER ROLE SET). Tiny pool — writes are rare and must never block a request.
func buildWritePoolConfig(dsn string) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "off"
	cfg.MinConns = 0
	cfg.MaxConns = 2
	return cfg, nil
}

// OpenWriteStore connects the read-write pool. The caller must Close it.
func OpenWriteStore(ctx context.Context, dsn string) (*WriteStore, error) {
	cfg, err := buildWritePoolConfig(dsn)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &WriteStore{pool: pool}, nil
}

// writeColumns is the RETURNING list — same projection ConversationByID reads, so the write's row
// builds the wire response without a second SELECT.
const writeColumns = `id, thread_id, title, created_at, last_activity_at,
                      model, owner, parent_id, user_titled, starred`

// SetStarred sets the star flag and returns the updated row ((nil,nil) if the row raced a delete).
func (s *WriteStore) SetStarred(ctx context.Context, id string, starred bool) (*ConversationRow, error) {
	return scanUpdated(s.pool.QueryRow(ctx,
		`UPDATE conversations SET starred = $2 WHERE id = $1 RETURNING `+writeColumns, id, starred))
}

// SetUserTitle sets the title AND locks it (user_titled=true), mirroring agent-host's setUserTitle.
func (s *WriteStore) SetUserTitle(ctx context.Context, id, title string) (*ConversationRow, error) {
	return scanUpdated(s.pool.QueryRow(ctx,
		`UPDATE conversations SET title = $2, user_titled = true WHERE id = $1 RETURNING `+writeColumns,
		id, title))
}

// scanUpdated maps a RETURNING row to a ConversationRow; no-rows (raced delete) becomes (nil, nil).
func scanUpdated(row pgx.Row) (*ConversationRow, error) {
	var c ConversationRow
	err := row.Scan(&c.ID, &c.ThreadID, &c.Title, &c.CreatedAt, &c.LastActivityAt,
		&c.Model, &c.Owner, &c.ParentID, &c.UserTitled, &c.Starred)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// Close releases the write pool. Safe on a nil WriteStore (the not-configured case).
func (s *WriteStore) Close() {
	if s != nil && s.pool != nil {
		s.pool.Close()
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// verifyTimeout bounds the boot-time read so a slow/unreachable DB can't delay the router
// coming up to serve proxy traffic (which does not depend on the DB).
const verifyTimeout = 5 * time.Second
