package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

type countingLabels struct {
	fakeLabels
	calls int
	err   error
}

func (c *countingLabels) ConversationByLabel(ctx context.Context, label string) (string, bool, error) {
	c.calls++
	if c.err != nil {
		return "", false, c.err
	}
	return c.fakeLabels.ConversationByLabel(ctx, label)
}

func TestLabelCache(t *testing.T) {
	ctx := context.Background()
	next := &countingLabels{fakeLabels: fakeLabels{"5a515e73": {"5a515e73-1"}, "aaaaaaaa": {"aaaaaaaa-1", "aaaaaaaa-2"}}}
	now := time.Unix(0, 0)
	c := newLabelCache(next)
	c.now = func() time.Time { return now }

	for range 3 {
		if id, ok, err := c.ConversationByLabel(ctx, "5a515e73"); id != "5a515e73-1" || !ok || err != nil {
			t.Fatalf("hit = (%q, %v, %v)", id, ok, err)
		}
	}
	if next.calls != 1 {
		t.Fatalf("a hit asked the store %d times, want 1", next.calls)
	}

	now = now.Add(labelCacheTTL)
	c.ConversationByLabel(ctx, "5a515e73")
	if next.calls != 2 {
		t.Fatalf("an expired hit was not re-read")
	}

	next.calls = 0
	for range 2 {
		if _, ok, _ := c.ConversationByLabel(ctx, "bbbbbbbb"); ok {
			t.Fatal("unknown label resolved")
		}
		if _, _, err := c.ConversationByLabel(ctx, "aaaaaaaa"); !errors.Is(err, ErrAmbiguousLabel) {
			t.Fatalf("ambiguous label: err = %v", err)
		}
	}
	if next.calls != 4 {
		t.Fatalf("misses asked the store %d times, want 4 (never cached)", next.calls)
	}

	next.err = errors.New("db down")
	if _, _, err := c.ConversationByLabel(ctx, "cccccccc"); err == nil {
		t.Fatal("store error swallowed")
	}
}
