package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShellInlinesChatPage(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "chat-page.css"), []byte("#layout{}"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "chat-page.js"), []byte("window.ChatPage={}"), 0o644)
	site := Site{Prefix: "/c/conv1", ChatURL: "https://scooter.example.com/chat/conv1", ChatPageDir: dir}
	shell, err := newShell(site)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	shell.ServeHTTP(rec, httptest.NewRequest("GET", "/c/conv1/review/orders", nil))
	body := rec.Body.String()
	for _, want := range []string{
		"<style>\n#layout{}</style>",
		"<script>\nwindow.ChatPage={}</script>",
		`"chatUrl":"https://scooter.example.com/chat/conv1"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	if strings.Contains(body, "@CHAT_PAGE@") {
		t.Error("placeholder left in the page")
	}
}

func TestShellNeedsChatPage(t *testing.T) {
	if _, err := newShell(Site{ChatPageDir: t.TempDir()}); err == nil {
		t.Fatal("want an error without chat-page.css")
	}
}
