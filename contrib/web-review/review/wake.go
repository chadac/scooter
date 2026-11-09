package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// source is the contrib's name, its UI source-table key.
const source = "web-review"

func quote(text string) string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	for i, l := range lines {
		lines[i] = "> " + l
	}
	return strings.Join(lines, "\n")
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func refString(r Ref) string {
	out := "`" + r.Selector + "`"
	if r.Text != "" {
		out += fmt.Sprintf(" (%q)", clip(r.Text, 60))
	}
	return out
}

// describe renders one note for the agent, without command hints.
func describe(n Note, shotsDir string) string {
	var b strings.Builder
	vp := n.Viewport
	scheme := vp.Scheme
	if scheme == "" {
		scheme = "light"
	}
	fmt.Fprintf(&b, "Review note #%d (%s) on %s, viewport %d×%d (%s):\n", n.ID, n.Kind, n.Route, vp.W, vp.H, scheme)
	if n.Kind == "area" {
		fmt.Fprintf(&b, "  area %.0f,%.0f → %.0f,%.0f inside %s\n", n.Doc.X, n.Doc.Y, n.Doc.X+n.Doc.W, n.Doc.Y+n.Doc.H, refString(n.Anchor))
		if len(n.Overlaps) > 0 {
			var parts []string
			for _, o := range n.Overlaps {
				parts = append(parts, "`"+o.Selector+"`")
			}
			fmt.Fprintf(&b, "  overlaps: %s\n", strings.Join(parts, ", "))
		}
	} else {
		fmt.Fprintf(&b, "  at %s\n", refString(n.Anchor))
		if n.HTML != "" {
			fmt.Fprintf(&b, "  html: %s\n", clip(n.HTML, 200))
		}
	}
	if len(n.Thread) > 0 {
		b.WriteString(quote(n.Thread[0].Text) + "\n")
	}
	if n.Shot != "" {
		fmt.Fprintf(&b, "Screenshot: %s", filepath.Join(shotsDir, n.Shot))
		if n.ShotWarning != "" {
			fmt.Fprintf(&b, " (may be incomplete: %s)", n.ShotWarning)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func sourceLine(t *Target) string {
	if t == nil {
		return ""
	}
	if t.Cwd != "" {
		return fmt.Sprintf("Source: %s (dev server :%d).\n", t.Cwd, t.Port)
	}
	return fmt.Sprintf("Dev server :%d.\n", t.Port)
}

func hints(ids ...int) string {
	id := "<id>"
	if len(ids) == 1 {
		id = fmt.Sprint(ids[0])
	}
	return fmt.Sprintf("`review reply %s \"…\"` · `review resolve %s` · `review snap` for the live page", id, id)
}

func noteMessage(n Note, shotsDir string, t *Target) string {
	return describe(n, shotsDir) + sourceLine(t) + hints(n.ID)
}

func batchMessage(notes []Note, shotsDir string, t *Target) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Review: %d notes.\n\n", len(notes))
	ids := make([]int, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
		b.WriteString(describe(n, shotsDir) + "\n")
	}
	return b.String() + sourceLine(t) + hints(ids...)
}

func replyMessage(n Note, text string) string {
	return fmt.Sprintf("Reply on review note #%d (%s on %s):\n%s\n%s", n.ID, n.Kind, n.Route, quote(text), hints(n.ID))
}

func reopenMessage(n Note) string {
	return fmt.Sprintf("Review note #%d on %s was reopened.\n%s", n.ID, n.Route, hints(n.ID))
}

// Waker posts a message into this conversation, which wakes the agent.
type Waker struct {
	site   Site
	client *http.Client
}

func (w *Waker) Send(text string) error {
	s := w.site
	if s.SelfURL == "" || s.TokenPath == "" || s.ConvID == "" {
		log.Printf("no SCOOTER_SELF_URL, token or CONVERSATION_ID: nobody woken")
		return nil
	}
	token, err := os.ReadFile(s.TokenPath)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"text": text, "source": source})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(s.SelfURL, "/")+"/conversations/"+s.ConvID+"/messages", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("content-type", "application/json")
	res, err := w.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("POST messages: %s", res.Status)
	}
	return nil
}
