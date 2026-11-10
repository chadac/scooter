package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

//go:embed static/shell.html
var shellHTML []byte

// Shell serves its page for every path, so deep links work.
type Shell struct {
	site Site
	page []byte
}

// newShell inlines chat-page.css and .js from site.ChatPageDir.
func newShell(site Site) (*Shell, error) {
	var head bytes.Buffer
	for _, f := range []struct{ name, tag string }{{"chat-page.css", "style"}, {"chat-page.js", "script"}} {
		src, err := os.ReadFile(filepath.Join(site.ChatPageDir, f.name))
		if err != nil {
			return nil, err
		}
		head.WriteString("<" + f.tag + ">\n")
		head.Write(src)
		head.WriteString("</" + f.tag + ">\n")
	}
	cfg, _ := json.Marshal(map[string]string{
		"appBase":   site.AppBase(),
		"shellBase": site.ShellBase(),
		"chatUrl":   site.ChatURL,
		"convUrl":   site.ConvURL,
	})
	// Safe in <script>: JSON escapes <, > and &.
	page := bytes.Replace(shellHTML, []byte("@CHAT_PAGE@"), head.Bytes(), 1)
	page = bytes.Replace(page, []byte("@CONFIG@"), cfg, 1)
	return &Shell{site: site, page: page}, nil
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
