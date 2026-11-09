package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const usage = `review: the web app review service, from the agent's side.

  review target <port>                    review a dev server already on <port>
  review target --run CMD --port N [--cwd DIR]
                                          run CMD as the dev server (restarted with the service)
  review target --clear                   stop reviewing
  review status                           target, open pages and the URL
  review list [--all]                     open notes (--all: resolved too)
  review reply <id> <text>                answer on the note's thread
  review resolve <id> | reopen <id>
  review show <id>                        a screenshot of the note (headless if it has none)
  review snap [--route /path]             capture the open review page; headless if none is open

The app is served under the base path in $REVIEW_BASE (also printed by status):
start your dev server with it (Vite --base, Next basePath, …).
`

type client struct {
	site Site
	http *http.Client
}

func (c *client) url(path string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/__review/%s", c.site.AppPort, path)
}

func (c *client) do(method, path string, body any, out any) (int, error) {
	var rd io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, c.url(path), rd)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		if os.Getenv("REVIEW_ENABLED") != "1" {
			return 0, errors.New(enableHint)
		}
		return 0, errors.New("the review service isn't running: scooter-service start review")
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		var e struct{ Error string }
		_ = json.Unmarshal(raw, &e)
		return res.StatusCode, fmt.Errorf("%s", firstNonEmpty(e.Error, res.Status))
	}
	if out != nil {
		return res.StatusCode, json.Unmarshal(raw, out)
	}
	return res.StatusCode, nil
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

func runCLI(site Site, args []string) error {
	c := &client{site: site, http: &http.Client{Timeout: 90 * time.Second}}
	if len(args) == 0 {
		fmt.Print(usage)
		return nil
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "target":
		return cliTarget(site, rest)
	case "status":
		var st map[string]any
		if _, err := c.do("GET", "status", nil, &st); err != nil {
			return err
		}
		out, _ := json.MarshalIndent(st, "", "  ")
		fmt.Println(string(out))
		if site.Public != nil {
			fmt.Printf("url: %s%s/\n", site.Public, site.ShellBase())
		}
		fmt.Printf("REVIEW_BASE=%s/\n", site.AppBase())
		return nil
	case "list":
		all := len(rest) > 0 && rest[0] == "--all"
		var st State
		if _, err := c.do("GET", "notes", nil, &st); err != nil {
			return err
		}
		shown := 0
		for _, n := range st.Notes {
			if n.Resolved && !all {
				continue
			}
			shown++
			state := "open"
			if n.Resolved {
				state = "resolved"
			} else if n.Held {
				state = "held"
			}
			fmt.Printf("[%s] %s", state, describe(n, site.ShotsDir()))
			for _, m := range n.Thread[min(1, len(n.Thread)):] {
				fmt.Printf("  %s: %s\n", m.By, clip(m.Text, 200))
			}
			fmt.Println()
		}
		if shown == 0 {
			fmt.Println("no open notes")
		}
		return nil
	case "reply":
		if len(rest) < 2 {
			return errors.New("usage: review reply <id> <text>")
		}
		_, err := c.do("POST", "notes/"+rest[0]+"/reply", map[string]string{"text": strings.Join(rest[1:], " "), "by": "agent"}, nil)
		return err
	case "resolve", "reopen":
		if len(rest) != 1 {
			return fmt.Errorf("usage: review %s <id>", cmd)
		}
		_, err := c.do("POST", "notes/"+rest[0]+"/resolve", map[string]any{"resolved": cmd == "resolve", "by": "agent"}, nil)
		return err
	case "show":
		if len(rest) != 1 {
			return errors.New("usage: review show <id>")
		}
		return cliShow(c, rest[0])
	case "snap":
		fs := flag.NewFlagSet("snap", flag.ContinueOnError)
		route := fs.String("route", "", "route for the headless fallback")
		if err := fs.Parse(rest); err != nil {
			return err
		}
		return cliSnap(c, *route)
	case "help", "-h", "--help":
		fmt.Print(usage)
		return nil
	}
	return fmt.Errorf("unknown command %q (see: review help)", cmd)
}

const enableHint = `Review is off. To list and start it, add to a module in /etc/scooter/modules/:
  webServices.review.enable = true;
then run: scooter-rebuild switch && scooter-service start review
`

func cliTarget(site Site, args []string) error {
	fs := flag.NewFlagSet("target", flag.ContinueOnError)
	run := fs.String("run", "", "dev server command")
	port := fs.Int("port", 0, "dev server port")
	cwd := fs.String("cwd", "", "dev server directory")
	clear := fs.Bool("clear", false, "stop reviewing")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *clear {
		if err := os.Remove(site.ConfigPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		fmt.Println("review target cleared")
		return nil
	}
	if fs.NArg() == 1 && *port == 0 {
		*port, _ = strconv.Atoi(fs.Arg(0))
	}
	if *port <= 0 || *port == site.AppPort || *port == site.ShellPort {
		return errors.New("usage: review target <port> | review target --run CMD --port N [--cwd DIR]")
	}
	t := Target{Port: *port, Run: *run}
	if *run != "" {
		dir := *cwd
		if dir == "" {
			dir, _ = os.Getwd()
		}
		t.Cwd, _ = filepath.Abs(dir)
		// systemd's PATH lacks the caller's tools.
		t.Env = map[string]string{"PATH": os.Getenv("PATH")}
	} else if *cwd != "" {
		t.Cwd, _ = filepath.Abs(*cwd)
	}
	if err := writeTarget(site, t); err != nil {
		return err
	}
	if os.Getenv("REVIEW_ENABLED") != "1" {
		fmt.Printf("saved; app base path: REVIEW_BASE=%s/\n%s", site.AppBase(), enableHint)
		return nil
	}
	out, err := exec.Command("scooter-service", "start", "review").CombinedOutput()
	os.Stdout.Write(out)
	if err != nil {
		return err
	}
	fmt.Printf("app base path: REVIEW_BASE=%s/\n", site.AppBase())
	return nil
}

func cliShow(c *client, id string) error {
	var st State
	if _, err := c.do("GET", "notes", nil, &st); err != nil {
		return err
	}
	n, err := find(&st, id)
	if err != nil {
		return err
	}
	{
		if n.Shot != "" {
			fmt.Println(filepath.Join(c.site.ShotsDir(), n.Shot))
			return nil
		}
		vp := n.Viewport
		vp.H = min(max(vp.H, int(n.Doc.Y+n.Doc.H)+48), 4000)
		full := filepath.Join(os.TempDir(), fmt.Sprintf("review-%s-full.png", id))
		out := filepath.Join(os.TempDir(), fmt.Sprintf("review-%s.png", id))
		if err := headless(c.site, n.Route, vp, full); err != nil {
			return err
		}
		if err := outlineCrop(full, out, n.Doc, 24); err != nil {
			return err
		}
		fmt.Println(out)
		fmt.Println("note: headless render from the URL; the user's page state isn't reproduced")
		return nil
	}
}

func cliSnap(c *client, route string) error {
	var res struct{ Path string }
	status, err := c.do("POST", "snap", map[string]string{}, &res)
	if err == nil {
		fmt.Println(res.Path)
		return nil
	}
	if status != http.StatusConflict && status != http.StatusGatewayTimeout {
		return err
	}
	out := filepath.Join(c.site.ShotsDir(), "snap-headless-"+time.Now().UTC().Format("20060102T150405")+".png")
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	if herr := headless(c.site, route, Viewport{W: 1280, H: 800}, out); herr != nil {
		return fmt.Errorf("%v; headless fallback: %v", err, herr)
	}
	fmt.Println(out)
	fmt.Printf("note: %v, so this is a headless render of %s\n", err, firstNonEmpty(route, "/"))
	return nil
}
