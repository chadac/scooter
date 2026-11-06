package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPgFolders(t *testing.T) {
	pool := startPG(t)
	s := &WriteStore{pool: pool}
	ctx := context.Background()
	insertConv(t, pool, "c1", "", "")
	insertConv(t, pool, "c2", "", "")

	list, err := s.Folders(ctx, "alice")
	if err != nil || len(list.Folders) != 1 || list.Folders[0].ID != StarredFolderID || len(list.Placements) != 0 {
		t.Fatalf("a new user sees only Starred: %+v, %v", list, err)
	}

	work, err := s.CreateFolder(ctx, "alice", "Work")
	if err != nil {
		t.Fatal(err)
	}
	home, _ := s.CreateFolder(ctx, "alice", "Home")
	if home.Position <= work.Position {
		t.Errorf("a new folder appends: work %v, home %v", work.Position, home.Position)
	}
	if _, err := s.CreateFolder(ctx, "alice", "work"); !errors.Is(err, errFolderNameTaken) {
		t.Errorf("names are unique per user, case-insensitively: %v", err)
	}
	if _, err := s.CreateFolder(ctx, "bob", "Work"); err != nil {
		t.Errorf("another user may reuse a name: %v", err)
	}

	// Starring moves a conversation out of its folder: one placement per user.
	if err := s.PlaceConversation(ctx, "alice", "c1", work.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.PlaceConversation(ctx, "alice", "c1", StarredFolderID); err != nil {
		t.Fatal(err)
	}
	if err := s.PlaceConversation(ctx, "alice", "c2", home.ID); err != nil {
		t.Fatal(err)
	}
	list, _ = s.Folders(ctx, "alice")
	if list.Placements["c1"] != StarredFolderID || list.Placements["c2"] != home.ID {
		t.Fatalf("placements = %v", list.Placements)
	}
	if other, _ := s.Folders(ctx, "bob"); len(other.Placements) != 0 {
		t.Errorf("placements are per user: bob sees %v", other.Placements)
	}

	// Unstar leaves a placement in a user folder alone.
	if err := s.Unstar(ctx, "alice", "c2"); err != nil {
		t.Fatal(err)
	}
	if err := s.Unstar(ctx, "alice", "c1"); err != nil {
		t.Fatal(err)
	}
	list, _ = s.Folders(ctx, "alice")
	if _, ok := list.Placements["c1"]; ok || list.Placements["c2"] != home.ID {
		t.Fatalf("after unstar: %v", list.Placements)
	}

	if err := s.PlaceConversation(ctx, "bob", "c1", work.ID); !errors.Is(err, errFolderNotFound) {
		t.Errorf("filing into someone else's folder is not found: %v", err)
	}
	if err := s.PlaceConversation(ctx, "alice", "gone", work.ID); !errors.Is(err, errFolderNotFound) {
		t.Errorf("filing a missing conversation is not found: %v", err)
	}

	name, icon, pos := "Personal", "house", 0.5
	if err := s.UpdateFolder(ctx, "alice", home.ID, FolderPatch{Name: &name, Icon: &icon, Position: &pos}); err != nil {
		t.Fatal(err)
	}
	list, _ = s.Folders(ctx, "alice")
	if got := list.Folders[1]; got.ID != home.ID || got.Name != "Personal" || got.Icon != "house" {
		t.Errorf("rename+icon+reorder: folders = %+v", list.Folders)
	}
	// A patch without an icon keeps it; an empty one clears it.
	if err := s.UpdateFolder(ctx, "alice", home.ID, FolderPatch{Position: &pos}); err != nil {
		t.Fatal(err)
	}
	if list, _ = s.Folders(ctx, "alice"); list.Folders[1].Icon != "house" {
		t.Errorf("icon dropped by an unrelated patch: %+v", list.Folders[1])
	}
	clear := ""
	if err := s.UpdateFolder(ctx, "alice", home.ID, FolderPatch{Icon: &clear}); err != nil {
		t.Fatal(err)
	}
	if list, _ = s.Folders(ctx, "alice"); list.Folders[1].Icon != "" {
		t.Errorf("icon not cleared: %+v", list.Folders[1])
	}
	if err := s.UpdateFolder(ctx, "bob", home.ID, FolderPatch{Name: &name}); !errors.Is(err, errFolderNotFound) {
		t.Errorf("renaming someone else's folder is not found: %v", err)
	}

	// Deleting a folder returns its conversations to Recent.
	if err := s.DeleteFolder(ctx, "alice", home.ID); err != nil {
		t.Fatal(err)
	}
	list, _ = s.Folders(ctx, "alice")
	if len(list.Placements) != 0 || len(list.Folders) != 2 {
		t.Errorf("after delete: %+v", list)
	}
	if err := s.DeleteFolder(ctx, "alice", home.ID); !errors.Is(err, errFolderNotFound) {
		t.Errorf("a second delete is not found: %v", err)
	}
}

func TestPgFolderPlacementsFollowConversations(t *testing.T) {
	pool := startPG(t)
	s := &WriteStore{pool: pool}
	ctx := context.Background()
	insertConv(t, pool, "c1", "", "")
	insertConv(t, pool, "c2", "", "")
	_, _ = pool.Exec(ctx, `UPDATE conversations SET owner = 'bob'`)
	for _, id := range []string{"c1", "c2"} {
		if err := s.PlaceConversation(ctx, "alice", id, StarredFolderID); err != nil {
			t.Fatal(err)
		}
	}
	// A conversation that went private to someone else drops out; an ended one is gone.
	_, _ = pool.Exec(ctx, `UPDATE conversations SET visibility = 'private' WHERE id = 'c1'`)
	_, _ = pool.Exec(ctx, `DELETE FROM conversations WHERE id = 'c2'`)
	list, _ := s.Folders(ctx, "alice")
	if len(list.Placements) != 0 {
		t.Errorf("placements = %v, want none", list.Placements)
	}
}

func TestPgStarMigrationCopiesOwnerStars(t *testing.T) {
	pool := startPG(t)
	ctx := context.Background()
	insertConv(t, pool, "a1", "", "")
	insertConv(t, pool, "a2", "", "")
	insertConv(t, pool, "child", "a1", "")
	insertConv(t, pool, "anon", "", "")
	_, _ = pool.Exec(ctx, `UPDATE conversations SET owner = 'alice', starred = true WHERE id IN ('a1', 'child')`)
	_, _ = pool.Exec(ctx, `UPDATE conversations SET owner = 'alice' WHERE id = 'a2'`)
	_, _ = pool.Exec(ctx, `UPDATE conversations SET starred = true WHERE id = 'anon'`)

	dir := os.Getenv("AGENT_HOST_MIGRATIONS")
	if dir == "" {
		dir = "../../lib/sql/agent_host/migrations"
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*_conversation_folders_stars_and_notify.sql"))
	if len(files) != 1 {
		t.Fatalf("star migration not found: %v", files)
	}
	sql, _ := os.ReadFile(files[0])
	copyPart, _, _ := strings.Cut(string(sql), "-- LIVE FOLDER PUSH")
	if _, err := pool.Exec(ctx, copyPart); err != nil {
		t.Fatal(err)
	}

	s := &WriteStore{pool: pool}
	alice, _ := s.Folders(ctx, "alice")
	if len(alice.Placements) != 1 || alice.Placements["a1"] != StarredFolderID {
		t.Errorf("alice's stars = %v, want a1 only (a subagent is never filed)", alice.Placements)
	}
	if anon, _ := s.Folders(ctx, ""); anon.Placements["anon"] != StarredFolderID {
		t.Errorf("an unowned star lands with the anonymous user: %v", anon.Placements)
	}
}

func TestPgFolderChangesNotifyTheirOwner(t *testing.T) {
	pool := startPG(t)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "listen "+foldersChannel); err != nil {
		t.Fatal(err)
	}
	s := &WriteStore{pool: pool}
	if _, err := s.CreateFolder(ctx, "alice", "Work"); err != nil {
		t.Fatal(err)
	}
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	n, err := conn.Conn().WaitForNotification(wctx)
	if err != nil {
		t.Fatal(err)
	}
	if owner, ok := folderNotifyOwner(n.Payload); !ok || owner != "alice" {
		t.Errorf("payload %q, want owner alice", n.Payload)
	}
}

func TestPgOwnersStarGuardsTheConversation(t *testing.T) {
	pool := startPG(t)
	s := &WriteStore{pool: pool}
	ctx := context.Background()
	insertConv(t, pool, "c1", "", "")
	_, _ = pool.Exec(ctx, `UPDATE conversations SET owner = 'alice'`)
	work, _ := s.CreateFolder(ctx, "alice", "Work")
	column := func() bool {
		var starred *bool
		if err := pool.QueryRow(ctx, `SELECT starred FROM conversations WHERE id = 'c1'`).Scan(&starred); err != nil {
			t.Fatal(err)
		}
		return starred != nil && *starred
	}

	// Someone else's star is theirs alone and doesn't protect the conversation.
	if err := s.PlaceConversation(ctx, "bob", "c1", StarredFolderID); err != nil || column() {
		t.Fatalf("bob's star: err %v, column %v", err, column())
	}
	if err := s.PlaceConversation(ctx, "alice", "c1", StarredFolderID); err != nil || !column() {
		t.Fatalf("the owner's star sets the guard: err %v, column %v", err, column())
	}
	// Moving it to another folder unstars it.
	if err := s.PlaceConversation(ctx, "alice", "c1", work.ID); err != nil || column() {
		t.Fatalf("filed elsewhere: err %v, column %v", err, column())
	}
	_ = s.PlaceConversation(ctx, "alice", "c1", StarredFolderID)
	if err := s.Unstar(ctx, "alice", "c1"); err != nil || column() {
		t.Fatalf("unstar: err %v, column %v", err, column())
	}
}
