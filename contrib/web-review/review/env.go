package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// env also reads PID 1's environ; units inherit no pod env.
func env(name string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	raw, err := os.ReadFile("/proc/1/environ")
	if err != nil {
		return ""
	}
	for _, kv := range bytes.Split(raw, []byte{0}) {
		if k, v, ok := strings.Cut(string(kv), "="); ok && k == name {
			return v
		}
	}
	return ""
}

func envInt(name string, def int) int {
	if n, err := strconv.Atoi(env(name)); err == nil {
		return n
	}
	return def
}

// Site locates the shell and app, in pod and browser.
type Site struct {
	Prefix      string // SCOOTER_SERVICE_PREFIX: "" or "/c/<id>"
	ShellPort   int
	AppPort     int
	StateDir    string
	Public      *url.URL // the browser's origin for both services
	ChatURL     string
	ConvURL     string
	ConvID      string
	SelfURL     string
	TokenPath   string
	Chromium    string
	VendorDir   string
	ChatPageDir string  // the shared chat-page.css and .js
	Target      *Target // from REVIEW_TARGET, rendered at rebuild time
}

func (s Site) ShellBase() string { return s.Prefix + "/review" }
func (s Site) AppBase() string   { return s.Prefix + "/review-app" }
func (s Site) ShotsDir() string  { return filepath.Join(s.StateDir, "shots") }

func loadSite() Site {
	s := Site{
		Prefix:      os.Getenv("SCOOTER_SERVICE_PREFIX"),
		ShellPort:   envInt("REVIEW_SHELL_PORT", 2731),
		AppPort:     envInt("REVIEW_APP_PORT", 2732),
		StateDir:    env("REVIEW_STATE_DIR"),
		ConvID:      env("CONVERSATION_ID"),
		SelfURL:     env("SCOOTER_SELF_URL"),
		TokenPath:   env("SCOOTER_SELF_TOKEN_PATH"),
		ChatURL:     env("SCOOTER_CHAT_URL"),
		ConvURL:     env("CONVERSATION_URL"),
		Chromium:    env("REVIEW_CHROMIUM"),
		VendorDir:   env("REVIEW_VENDOR_DIR"),
		ChatPageDir: env("REVIEW_CHAT_PAGE_DIR"),
	}
	if p := env("REVIEW_TARGET"); p != "" {
		t, err := readTarget(p)
		if err != nil {
			log.Printf("REVIEW_TARGET: %v", err)
		}
		s.Target = t
	}
	if _, set := os.LookupEnv("SCOOTER_SERVICE_PREFIX"); !set {
		// Without a services origin, services live under /c/<id>/.
		if env("SCOOTER_SERVICES_ORIGIN") == "" && s.ConvID != "" {
			s.Prefix = "/c/" + s.ConvID
		}
	}
	if s.StateDir == "" {
		s.StateDir = "/workspace/.scooter/review"
	}
	origin := env("SCOOTER_SERVICES_ORIGIN")
	if origin == "" {
		origin = env("CONVERSATION_URL")
	}
	if u, err := url.Parse(origin); err == nil && u.Host != "" {
		s.Public = &url.URL{Scheme: u.Scheme, Host: u.Host}
	}
	if s.ChatURL == "" && s.ConvID != "" {
		if u, err := url.Parse(env("CONVERSATION_URL")); err == nil && u.Host != "" {
			s.ChatURL = u.Scheme + "://" + u.Host + "/chat/" + s.ConvID
		}
	}
	return s
}

// Target is the app under review: webReview.target, set by `review target`.
type Target struct {
	Port int               `json:"port"`
	Run  string            `json:"run,omitempty"` // the dev server, run as devUnit
	Cwd  string            `json:"cwd,omitempty"`
	Unit string            `json:"unit,omitempty"` // a unit already serving Port
	Env  map[string]string `json:"env,omitempty"`
}

// devUnit runs Target.Run.
const devUnit = "webservice-review-dev"

// LogUnit is the unit whose journal explains a dead dev server.
func (t *Target) LogUnit() string {
	switch {
	case t.Run != "":
		return devUnit
	case t.Unit != "":
		return t.Unit
	}
	return ""
}

func readTarget(path string) (*Target, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var t Target
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, err
	}
	if t.Port <= 0 {
		return nil, errors.New(path + ": no port")
	}
	return &t, nil
}

// devEnv tells the dev server where the browser will see it.
func (s Site) devEnv(t *Target) map[string]string {
	e := map[string]string{
		"PORT":        strconv.Itoa(t.Port),
		"REVIEW_BASE": s.AppBase() + "/",
	}
	if s.Public != nil {
		e["REVIEW_PUBLIC_URL"] = s.Public.String() + s.AppBase() + "/"
	}
	return e
}

// writeJSON replaces a file atomically.
func writeJSON(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
