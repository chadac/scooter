// Read-only access to the linked-resource rows (resource_links) the sidebar enriches each
// conversation with — the GitHub PR / Slack thread / Jira badges. These live in the WEBHOOKS
// database (webhooks owns the table), a different database than the conversation metadata, so
// this is a second read-only pool. Same conversation_router role, same read-only guarantees
// (server-side role + client-side default_transaction_read_only via buildPoolConfig).
//
// Optional: with no WEBHOOKS_DB_* configured (webhooks disabled), the list is served WITHOUT
// enrichment — bare rows, exactly as the agent-host degrades to when its link store is absent.
package main

import (
	"context"
	"fmt"
	"net/url"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Link is one linked resource, projected to the four fields the sidebar list shows (matching
// agent-host's withSources: source, resourceType, url, title).
type Link struct {
	Source       string  `json:"source"`
	ResourceType string  `json:"resourceType"`
	URL          *string `json:"url,omitempty"`
	Title        *string `json:"title,omitempty"`
}

// LinkStore is a read-only handle on the webhooks database's resource_links table. nil when
// webhooks (and thus the links DB + grant) is not configured.
type LinkStore struct {
	pool *pgxpool.Pool
}

// OpenLinkStore connects the read-only links pool (read-only pinned via buildPoolConfig, same
// as the metadata store). The caller must Close it.
func OpenLinkStore(ctx context.Context, dsn string) (*LinkStore, error) {
	cfg, err := buildPoolConfig(dsn)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &LinkStore{pool: pool}, nil
}

// linkStoreDSNFromEnv assembles the webhooks DSN from WEBHOOKS_DB_* (the router's read-only
// conversation_router credentials on the webhooks database). "" when not configured.
func linkStoreDSNFromEnv() string {
	if dsn := os.Getenv("WEBHOOKS_DB_DSN"); dsn != "" {
		return dsn
	}
	pw := os.Getenv("WEBHOOKS_DB_PASSWORD")
	if pw == "" {
		return ""
	}
	host := envOr("WEBHOOKS_DB_HOST", "agent-shared-db")
	port := envOr("WEBHOOKS_DB_PORT", "5432")
	name := envOr("WEBHOOKS_DB_NAME", "webhooks")
	user := envOr("WEBHOOKS_DB_USER", "conversation_router")
	dsn := fmt.Sprintf("postgresql://%s:%s@%s:%s/%s",
		url.QueryEscape(user), url.QueryEscape(pw), host, port, name)
	if ssl := os.Getenv("WEBHOOKS_DB_SSLMODE"); ssl != "" {
		dsn += "?sslmode=" + url.QueryEscape(ssl)
	}
	return dsn
}

// LinksByConversation reads EVERY link once and groups by conversation id — one query for the
// whole list, not one per row (which is what made listLinks-per-conversation a fan of N reads).
func (s *LinkStore) LinksByConversation(ctx context.Context) (map[string][]Link, error) {
	rs, err := s.pool.Query(ctx, `
		SELECT conversation_id, source, resource_type, url, title
		  FROM resource_links`)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	out := map[string][]Link{}
	for rs.Next() {
		var convID string
		var l Link
		if err := rs.Scan(&convID, &l.Source, &l.ResourceType, &l.URL, &l.Title); err != nil {
			return nil, err
		}
		out[convID] = append(out[convID], l)
	}
	return out, rs.Err()
}

// Close releases the pool. Safe on a nil LinkStore (the not-configured case).
func (s *LinkStore) Close() {
	if s != nil && s.pool != nil {
		s.pool.Close()
	}
}
