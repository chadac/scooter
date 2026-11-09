package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"html"
	"net/http"
	"strings"
)

//go:embed static/shell.html
var shellHTML []byte

// Shell serves its page for every path, so deep links work.
type Shell struct {
	site Site
	page []byte
}

func newShell(site Site) *Shell {
	cfg, _ := json.Marshal(map[string]string{
		"appBase":   site.AppBase(),
		"shellBase": site.ShellBase(),
		"chatUrl":   site.ChatURL,
		"convUrl":   site.ConvURL,
	})
	// Safe in <script>: JSON escapes <, > and &.
	page := bytes.Replace(shellHTML, []byte("@CONFIG@"), cfg, 1)
	page = bytes.ReplaceAll(page, []byte("@APP_BASE@"), []byte(html.EscapeString(site.AppBase())))
	return &Shell{site: site, page: page}
}

func (s *Shell) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	base := s.site.ShellBase()
	if r.URL.Path == base {
		http.Redirect(w, r, base+"/", http.StatusFound)
		return
	}
	if !strings.HasPrefix(r.URL.Path, base+"/") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(s.page)
}
