package main

import (
	"strings"
	"testing"
)

// storeDSNFromEnv is the wiring seam between the k8s env and the pool. These lock down the two
// ways it can silently misbehave: leaking a wrong default, or building a DSN when no DB is
// configured (which would make the router try — and fail — to connect on every boot).
func TestStoreDSNFromEnv(t *testing.T) {
	clear := func() {
		for _, k := range []string{
			"AGENT_HOST_DB_DSN", "AGENT_HOST_DB_PASSWORD", "AGENT_HOST_DB_HOST",
			"AGENT_HOST_DB_PORT", "AGENT_HOST_DB_NAME", "AGENT_HOST_DB_USER", "AGENT_HOST_DB_SSLMODE",
		} {
			t.Setenv(k, "")
		}
	}

	t.Run("no password means not configured", func(t *testing.T) {
		clear()
		if dsn := storeDSNFromEnv(); dsn != "" {
			t.Fatalf("want empty DSN when unconfigured, got %q", dsn)
		}
	})

	t.Run("explicit DSN wins", func(t *testing.T) {
		clear()
		t.Setenv("AGENT_HOST_DB_DSN", "postgresql://x/y")
		t.Setenv("AGENT_HOST_DB_PASSWORD", "ignored")
		if dsn := storeDSNFromEnv(); dsn != "postgresql://x/y" {
			t.Fatalf("explicit DSN not honored, got %q", dsn)
		}
	})

	t.Run("assembled from components with reader defaults", func(t *testing.T) {
		clear()
		t.Setenv("AGENT_HOST_DB_PASSWORD", "p@ss/word")
		t.Setenv("AGENT_HOST_DB_HOST", "agent-shared-db.ns.svc")
		dsn := storeDSNFromEnv()
		// Default user is the read-only role, default db is agent_host, and the password is escaped.
		if !strings.Contains(dsn, "conversation_router:") {
			t.Errorf("expected default read-only user in DSN: %q", dsn)
		}
		if !strings.HasSuffix(dsn, "@agent-shared-db.ns.svc:5432/agent_host") {
			t.Errorf("host/port/db not assembled as expected: %q", dsn)
		}
		if strings.Contains(dsn, "p@ss/word") {
			t.Errorf("password must be URL-escaped, not raw: %q", dsn)
		}
	})

	t.Run("sslmode appended when set", func(t *testing.T) {
		clear()
		t.Setenv("AGENT_HOST_DB_PASSWORD", "pw")
		t.Setenv("AGENT_HOST_DB_SSLMODE", "require")
		if dsn := storeDSNFromEnv(); !strings.HasSuffix(dsn, "?sslmode=require") {
			t.Fatalf("sslmode not appended: %q", dsn)
		}
	})
}

// The client-side half of the read-only guarantee: EVERY connection the pool opens must carry
// default_transaction_read_only=on, so a mis-provisioned grant can't become a write from here.
func TestBuildPoolConfigIsReadOnly(t *testing.T) {
	cfg, err := buildPoolConfig("postgresql://u:p@h:5432/agent_host")
	if err != nil {
		t.Fatalf("buildPoolConfig: %v", err)
	}
	if got := cfg.ConnConfig.RuntimeParams["default_transaction_read_only"]; got != "on" {
		t.Fatalf("connection not pinned read-only: got %q", got)
	}
	if cfg.MinConns != 0 {
		t.Errorf("want MinConns=0 for an idle-cheap proxy pool, got %d", cfg.MinConns)
	}
}
