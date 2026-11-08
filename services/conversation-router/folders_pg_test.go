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

	work, err := s.CreateFolder(ctx, "alice", "Work", "", false, false)
	if err != nil {
		t.Fatal(err)
	}
	home, _ := s.CreateFolder(ctx, "alice", "Home", "", false, false)
	if home.Position <= work.Position {
		t.Errorf("a new folder appends: work %v, home %v", work.Position, home.Position)
	}
	if _, err := s.CreateFolder(ctx, "alice", "work", "", false, false); !errors.Is(err, errFolderNameTaken) {
		t.Errorf("names are unique per user, case-insensitively: %v", err)
	}
	if _, err := s.CreateFolder(ctx, "bob", "Work", "", false, false); err != nil {
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
	if err := s.UpdateFolder(ctx, "alice", home.ID, FolderPatch{Name: &name, Icon: &icon, Position: &pos}, false); err != nil {
		t.Fatal(err)
	}
	list, _ = s.Folders(ctx, "alice")
	if got := list.Folders[1]; got.ID != home.ID || got.Name != "Personal" || got.Icon != "house" {
		t.Errorf("rename+icon+reorder: folders = %+v", list.Folders)
	}
	// A patch without an icon keeps it; an empty one clears it.
	if err := s.UpdateFolder(ctx, "alice", home.ID, FolderPatch{Position: &pos}, false); err != nil {
		t.Fatal(err)
	}
	if list, _ = s.Folders(ctx, "alice"); list.Folders[1].Icon != "house" {
		t.Errorf("icon dropped by an unrelated patch: %+v", list.Folders[1])
	}
	clear := ""
	if err := s.UpdateFolder(ctx, "alice", home.ID, FolderPatch{Icon: &clear}, false); err != nil {
		t.Fatal(err)
	}
	if list, _ = s.Folders(ctx, "alice"); list.Folders[1].Icon != "" {
		t.Errorf("icon not cleared: %+v", list.Folders[1])
	}
	if err := s.UpdateFolder(ctx, "bob", home.ID, FolderPatch{Name: &name}, false); !errors.Is(err, errFolderNotFound) {
		t.Errorf("renaming someone else's folder is not found: %v", err)
	}

	// Deleting a folder returns its conversations to Recent.
	if err := s.DeleteFolder(ctx, "alice", home.ID, false, false); err != nil {
		t.Fatal(err)
	}
	list, _ = s.Folders(ctx, "alice")
	if len(list.Placements) != 0 || len(list.Folders) != 2 {
		t.Errorf("after delete: %+v", list)
	}
	if err := s.DeleteFolder(ctx, "alice", home.ID, false, false); !errors.Is(err, errFolderNotFound) {
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
	if _, err := s.CreateFolder(ctx, "alice", "Work", "", false, false); err != nil {
		t.Fatal(err)
	}
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	n, err := conn.Conn().WaitForNotification(wctx)
	if err != nil {
		t.Fatal(err)
	}
	if owner, _, ok := folderNotify(n.Payload); !ok || owner != "alice" {
		t.Errorf("payload %q, want owner alice", n.Payload)
	}
}

func TestPgOwnersStarGuardsTheConversation(t *testing.T) {
	pool := startPG(t)
	s := &WriteStore{pool: pool}
	ctx := context.Background()
	insertConv(t, pool, "c1", "", "")
	_, _ = pool.Exec(ctx, `UPDATE conversations SET owner = 'alice'`)
	work, _ := s.CreateFolder(ctx, "alice", "Work", "", false, false)
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

func TestPgNestedFolders(t *testing.T) {
	pool := startPG(t)
	s := &WriteStore{pool: pool}
	ctx := context.Background()
	insertConv(t, pool, "c1", "", "")
	insertConv(t, pool, "c2", "", "")

	work, _ := s.CreateFolder(ctx, "alice", "Work", "", false, false)
	proj, err := s.CreateFolder(ctx, "alice", "Scooter", work.ID, false, false)
	if err != nil || proj.ParentID != work.ID {
		t.Fatalf("subfolder: %+v, %v", proj, err)
	}
	ui, err := s.CreateFolder(ctx, "alice", "UI", proj.ID, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateFolder(ctx, "alice", "Deeper", ui.ID, false, false); !errors.Is(err, errFolderTooDeep) {
		t.Errorf("a 4th level is refused: %v", err)
	}
	if _, err := s.CreateFolder(ctx, "alice", "UI", work.ID, false, false); err != nil {
		t.Errorf("names are unique per parent, not per user: %v", err)
	}
	if _, err := s.CreateFolder(ctx, "alice", "ui", proj.ID, false, false); !errors.Is(err, errFolderNameTaken) {
		t.Errorf("a sibling can't share a name: %v", err)
	}
	if _, err := s.CreateFolder(ctx, "bob", "X", work.ID, false, false); !errors.Is(err, errFolderNotFound) {
		t.Errorf("nesting in someone else's folder is not found: %v", err)
	}

	top := ""
	if err := s.UpdateFolder(ctx, "alice", work.ID, FolderPatch{ParentID: &ui.ID}, false); !errors.Is(err, errFolderCycle) {
		t.Errorf("a folder can't move into its own subtree: %v", err)
	}
	other, _ := s.CreateFolder(ctx, "alice", "Other", "", false, false)
	if err := s.UpdateFolder(ctx, "alice", work.ID, FolderPatch{ParentID: &other.ID}, false); !errors.Is(err, errFolderTooDeep) {
		t.Errorf("a 3-deep subtree can't go one level down: %v", err)
	}
	if err := s.UpdateFolder(ctx, "alice", ui.ID, FolderPatch{ParentID: &top}, false); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateFolder(ctx, "alice", proj.ID, FolderPatch{ParentID: &other.ID}, false); err != nil {
		t.Errorf("a 1-deep subfolder fits under another top-level one: %v", err)
	}
	list, _ := s.Folders(ctx, "alice")
	byID := map[string]Folder{}
	for _, f := range list.Folders {
		byID[f.ID] = f
	}
	if byID[ui.ID].ParentID != "" || byID[proj.ID].ParentID != other.ID {
		t.Errorf("after moves: %+v", list.Folders)
	}
	if byID[ui.ID].Position <= byID[other.ID].Position {
		t.Errorf("a move without a position appends: %+v", list.Folders)
	}

	// Deleting lifts contents a level, keeping their order and conversations.
	a, _ := s.CreateFolder(ctx, "alice", "A", proj.ID, false, false)
	b, _ := s.CreateFolder(ctx, "alice", "Scooter", proj.ID, false, false)
	_ = s.PlaceConversation(ctx, "alice", "c1", proj.ID)
	_ = s.PlaceConversation(ctx, "alice", "c2", a.ID)
	if err := s.DeleteFolder(ctx, "alice", proj.ID, false, false); err != nil {
		t.Fatalf("a child may share its old parent's name: %v", err)
	}
	list, _ = s.Folders(ctx, "alice")
	byID = map[string]Folder{}
	for _, f := range list.Folders {
		byID[f.ID] = f
	}
	if byID[a.ID].ParentID != other.ID || byID[b.ID].ParentID != other.ID || byID[a.ID].Position >= byID[b.ID].Position {
		t.Errorf("lifted children: %+v", list.Folders)
	}
	if list.Placements["c1"] != other.ID || list.Placements["c2"] != a.ID {
		t.Errorf("lifted placements: %v", list.Placements)
	}

	// Deleting with subfolders drops the subtree, unfiling it all.
	if err := s.DeleteFolder(ctx, "alice", other.ID, true, false); err != nil {
		t.Fatal(err)
	}
	list, _ = s.Folders(ctx, "alice")
	for _, f := range list.Folders {
		if f.ID == a.ID || f.ID == b.ID {
			t.Errorf("subfolder survived: %+v", f)
		}
	}
	if len(list.Placements) != 0 {
		t.Errorf("placements after a subtree delete: %v", list.Placements)
	}
}

func TestPgFolderLifetimes(t *testing.T) {
	pool := startPG(t)
	week := 168
	s := &WriteStore{pool: pool}
	ctx := context.Background()

	done, _ := s.CreateFolder(ctx, "alice", "Done", "", false, false)
	if err := s.UpdateFolder(ctx, "alice", done.ID, FolderPatch{ConversationLifetimeHours: optionalInt{Set: true, Value: &week}}, false); err != nil {
		t.Fatal(err)
	}
	list, _ := s.Folders(ctx, "alice")
	if got := list.Folders[1]; got.ID != done.ID || got.ConversationLifetimeHours == nil || *got.ConversationLifetimeHours != week {
		t.Errorf("lifetime not saved: %+v", list.Folders)
	}
	// An unrelated patch keeps it; an explicit null clears it.
	name := "Finished"
	_ = s.UpdateFolder(ctx, "alice", done.ID, FolderPatch{Name: &name}, false)
	if list, _ = s.Folders(ctx, "alice"); list.Folders[1].ConversationLifetimeHours == nil {
		t.Errorf("lifetime dropped by a rename")
	}
	_ = s.UpdateFolder(ctx, "alice", done.ID, FolderPatch{ConversationLifetimeHours: optionalInt{Set: true}}, false)
	if list, _ = s.Folders(ctx, "alice"); list.Folders[1].ConversationLifetimeHours != nil {
		t.Errorf("lifetime not cleared: %+v", list.Folders[1])
	}

}

func TestPgLockedFolders(t *testing.T) {
	pool := startPG(t)
	s := &WriteStore{pool: pool}
	ctx := context.Background()
	insertConv(t, pool, "c1", "", "")
	const user, service = false, true

	board, err := s.CreateFolder(ctx, "alice", "Board", "", true, service)
	if err != nil {
		t.Fatal(err)
	}
	list, _ := s.Folders(ctx, "alice")
	if len(list.Folders) != 2 || list.Folders[1].ID != board.ID || !list.Folders[1].Locked || !list.Folders[0].Locked {
		t.Fatalf("Starred then the locked board: %+v", list.Folders)
	}

	// Users file conversations in and out, and change nothing else.
	if err := s.PlaceConversation(ctx, "alice", "c1", board.ID); err != nil {
		t.Fatal(err)
	}
	if list, _ = s.Folders(ctx, "alice"); list.Placements["c1"] != board.ID {
		t.Errorf("placements = %v", list.Placements)
	}
	name := "Mine"
	if err := s.UpdateFolder(ctx, "alice", board.ID, FolderPatch{Name: &name}, user); !errors.Is(err, errFolderLocked) {
		t.Errorf("user rename: %v", err)
	}
	if err := s.DeleteFolder(ctx, "alice", board.ID, false, user); !errors.Is(err, errFolderLocked) {
		t.Errorf("user delete: %v", err)
	}
	if _, err := s.CreateFolder(ctx, "alice", "Sub", board.ID, false, user); !errors.Is(err, errFolderLocked) {
		t.Errorf("user subfolder: %v", err)
	}
	work, _ := s.CreateFolder(ctx, "alice", "Work", "", false, user)
	if err := s.UpdateFolder(ctx, "alice", work.ID, FolderPatch{ParentID: &board.ID}, user); !errors.Is(err, errFolderLocked) {
		t.Errorf("user move into a locked folder: %v", err)
	}

	// Locked folders sit at the top or in locked ones.
	if _, err := s.CreateFolder(ctx, "alice", "Lane", work.ID, true, service); !errors.Is(err, errLockedParent) {
		t.Errorf("locked in an unlocked parent: %v", err)
	}
	lane, err := s.CreateFolder(ctx, "alice", "Lane", board.ID, true, service)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateFolder(ctx, "alice", lane.ID, FolderPatch{ParentID: &work.ID}, service); !errors.Is(err, errLockedParent) {
		t.Errorf("locked moved under an unlocked parent: %v", err)
	}

	// The service changes it, and deleting it unfiles its conversations.
	if err := s.UpdateFolder(ctx, "alice", board.ID, FolderPatch{Name: &name}, service); err != nil {
		t.Errorf("service rename: %v", err)
	}
	if err := s.DeleteFolder(ctx, "alice", board.ID, true, service); err != nil {
		t.Fatal(err)
	}
	if list, _ = s.Folders(ctx, "alice"); len(list.Placements) != 0 || len(list.Folders) != 2 {
		t.Errorf("after delete: %+v", list)
	}
}

func TestPgOwnerEventsReachTheFolderListener(t *testing.T) {
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
	if err := s.NotifyFolders(ctx, []byte(`{"owner":"alice","contrib":"notes","conversations":["c1"]}`)); err != nil {
		t.Fatal(err)
	}
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	n, err := conn.Conn().WaitForNotification(wctx)
	if err != nil {
		t.Fatal(err)
	}
	owner, frame, ok := folderNotify(n.Payload)
	if !ok || owner != "alice" || !strings.Contains(string(frame), `"contrib":"notes"`) {
		t.Errorf("payload %q gave %q %s", n.Payload, owner, frame)
	}
}
