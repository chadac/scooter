// Postgres access for the router: a read-only pool (Store) for the list/LISTEN path and a
// narrow write pool (WriteStore) for idle title writes and folders.
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

// ConversationRow is the durable metadata the sidebar list needs, a projection rather than a full mirror of the agent-host row.
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
	// Columns converged by every phase writer, never a read-time join against the CR; NULL is a legal read.
	Phase      *string
	SandboxRef *string
	// Turn state for the sidebar dot; both NULL until the first run.
	RunStartedAt *int64
	LastReplyAt  *int64
	// Set while the agent waits on the user's answer, from AwaitingStore; nil otherwise.
	AwaitingInputAt *int64
	// "shared" or "private"; NOT NULL in the schema, and "" (a test row) reads as shared.
	Visibility string
}

// conversationColumns is the one projection list, shared by the SELECTs and the write path's RETURNING so they cannot drift.
const conversationColumns = `id, thread_id, title, created_at, last_activity_at,
                             model, owner, parent_id, user_titled, phase, sandbox_ref,
                             run_started_at, last_reply_at, visibility`

// scannable is satisfied by both pgx.Row and pgx.Rows, so one scan helper serves every read.
type scannable interface {
	Scan(dest ...any) error
}

func scanConversation(s scannable, c *ConversationRow) error {
	return s.Scan(&c.ID, &c.ThreadID, &c.Title, &c.CreatedAt, &c.LastActivityAt,
		&c.Model, &c.Owner, &c.ParentID, &c.UserTitled, &c.Phase, &c.SandboxRef,
		&c.RunStartedAt, &c.LastReplyAt, &c.Visibility)
}

// Store is a read-only handle on the agent_host database, nil when no DSN is configured.
type Store struct {
	pool *pgxpool.Pool
	// connConfig is the read-only-pinned single-connection config the LISTEN loop opens a dedicated connection from, since a LISTEN would otherwise starve the tiny request pool.
	connConfig *pgx.ConnConfig
	// awaiting fills AwaitingInputAt on every row read, nil when no contrib provides it.
	awaiting *AwaitingStore
}

// storeDSNFromEnv assembles the agent_host connection string from AGENT_HOST_DB_DSN or the AGENT_HOST_DB_* parts, returning "" when no password is set.
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

// buildPoolConfig parses dsn and pins the connection to read-only.
func buildPoolConfig(dsn string) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	// The client-side half of the read-only guarantee; the DB role is the other half.
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	// Keep the footprint tiny and never block a request on the DB.
	cfg.MinConns = 0
	cfg.MaxConns = 4
	return cfg, nil
}

// OpenStore connects the read-only pool, which the caller must Close.
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

// NewListenConn opens a dedicated read-only connection for the LISTEN loop, which the caller must Close.
func (s *Store) NewListenConn(ctx context.Context) (*pgx.Conn, error) {
	return pgx.ConnectConfig(ctx, s.connConfig)
}

// CountConversations reads the conversations table, verifying the SELECT grant at boot.
func (s *Store) CountConversations(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, "SELECT count(*) FROM conversations").Scan(&n)
	return n, err
}

// Conversations returns every conversation's durable metadata most-recently-active first with created_at breaking ties; this ORDER BY alone establishes the GET /conversations order.
func (s *Store) Conversations(ctx context.Context) ([]ConversationRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+conversationColumns+`
		  FROM conversations
		 ORDER BY last_activity_at DESC, created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ConversationRow
	for rows.Next() {
		var c ConversationRow
		if err := scanConversation(rows, &c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	s.awaiting.fill(ctx, out)
	return out, nil
}

// ConversationByID reads one conversation's durable metadata, returning (nil, nil) when the row is gone.
func (s *Store) ConversationByID(ctx context.Context, id string) (*ConversationRow, error) {
	var c ConversationRow
	err := scanConversation(s.pool.QueryRow(ctx, `
		SELECT `+conversationColumns+`
		  FROM conversations
		 WHERE id = $1`, id), &c)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.awaiting.fillOne(ctx, &c)
	return &c, nil
}

// Close releases the pool and is safe on a nil Store.
func (s *Store) Close() {
	if s != nil && s.pool != nil {
		s.pool.Close()
	}
}

// WriteStore writes conversations: idle metadata, creates, assignment claims.
type WriteStore struct {
	pool *pgxpool.Pool
	// awaiting fills AwaitingInputAt on RETURNING rows, nil when no contrib provides it.
	awaiting *AwaitingStore
	// statics are the deployment's static folders, after Starred.
	statics []StaticFolder
}

// buildWritePoolConfig pins the pool read-write, overriding the role's read-only default.
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
	cfg.MaxConns = 8
	return cfg, nil
}

// OpenWriteStore connects the read-write pool, which the caller must Close.
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

// writeColumns is the RETURNING list, the same projection ConversationByID reads.
const writeColumns = conversationColumns

// SetUserTitle sets the title and locks it with user_titled=true, mirroring agent-host's setUserTitle.
func (s *WriteStore) SetUserTitle(ctx context.Context, id, title string) (*ConversationRow, error) {
	return s.withAwaiting(ctx)(scanUpdated(s.pool.QueryRow(ctx,
		`UPDATE conversations SET title = $2, user_titled = true WHERE id = $1 RETURNING `+writeColumns,
		id, title)))
}

// withAwaiting fills an updated row's AwaitingInputAt, so a PATCH reply keeps the "!".
func (s *WriteStore) withAwaiting(ctx context.Context) func(*ConversationRow, error) (*ConversationRow, error) {
	return func(c *ConversationRow, err error) (*ConversationRow, error) {
		if err == nil {
			s.awaiting.fillOne(ctx, c)
		}
		return c, err
	}
}

// SetVisibility sets the visibility of a conversation and every descendant (they share its pod)
// in one statement, returning the root's updated row, (nil, nil) if it raced a delete.
func (s *WriteStore) SetVisibility(ctx context.Context, id, visibility string) (*ConversationRow, error) {
	return s.withAwaiting(ctx)(scanUpdated(s.pool.QueryRow(ctx, `
		WITH RECURSIVE tree(id) AS (
		  SELECT $1::text
		  UNION SELECT c.id FROM conversations c JOIN tree t ON c.parent_id = t.id
		), upd AS (
		  UPDATE conversations SET visibility = $2 WHERE id IN (SELECT id FROM tree)
		  RETURNING `+writeColumns+`
		)
		SELECT `+writeColumns+` FROM upd WHERE id = $1`, id, visibility)))
}

// CreateConversation inserts the create-time row, which is the conversation: it lists before its first prompt and the controller assigns it from there.
func (s *WriteStore) CreateConversation(ctx context.Context, c NewConversation) error {
	_, err := s.pool.Exec(ctx, insertConversationSQL, conversationRowOf(c, time.Now().UnixMilli()).args()...)
	return err
}

// scanUpdated maps a RETURNING row to a ConversationRow, with no rows becoming (nil, nil).
func scanUpdated(row pgx.Row) (*ConversationRow, error) {
	var c ConversationRow
	err := scanConversation(row, &c)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// Close releases the write pool and is safe on a nil WriteStore.
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

// verifyTimeout bounds the boot-time read so a slow DB cannot delay the router serving proxy traffic.
const verifyTimeout = 5 * time.Second
