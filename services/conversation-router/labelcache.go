package main

import (
	"context"
	"sync"
	"time"
)

// A found label always names the same conversation.
const (
	labelCacheTTL = 5 * time.Minute
	labelCacheMax = 4096
)

// labelCache keeps found labels; misses and errors are re-asked.
type labelCache struct {
	next labelResolver
	now  func() time.Time

	mu      sync.Mutex
	entries map[string]labelEntry
}

type labelEntry struct {
	id      string
	expires time.Time
}

func newLabelCache(next labelResolver) *labelCache {
	return &labelCache{next: next, now: time.Now, entries: map[string]labelEntry{}}
}

func (c *labelCache) ConversationByLabel(ctx context.Context, label string) (string, bool, error) {
	now := c.now()
	c.mu.Lock()
	e, ok := c.entries[label]
	c.mu.Unlock()
	if ok && now.Before(e.expires) {
		return e.id, true, nil
	}
	id, found, err := c.next.ConversationByLabel(ctx, label)
	if err != nil || !found {
		return id, found, err
	}
	c.mu.Lock()
	if len(c.entries) >= labelCacheMax {
		c.pruneLocked(now)
	}
	c.entries[label] = labelEntry{id: id, expires: now.Add(labelCacheTTL)}
	c.mu.Unlock()
	return id, true, nil
}

func (c *labelCache) pruneLocked(now time.Time) {
	for k, e := range c.entries {
		if !now.Before(e.expires) {
			delete(c.entries, k)
		}
	}
	if len(c.entries) >= labelCacheMax {
		c.entries = map[string]labelEntry{}
	}
}
