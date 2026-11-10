// scooter-review: the web app review service (contrib/web-review).
//
//	scooter-review proxy   the review-app unit: the dev server behind a rewriting proxy, and the notes API
//	scooter-review shell   the review unit: the chat beside the app
//	scooter-review dev     the webservice-review-dev unit: webReview.target.run
//	review …               the agent's CLI (this binary under another name)
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

func main() {
	site := loadSite()
	args := os.Args[1:]
	if filepath.Base(os.Args[0]) != "review" && len(args) > 0 {
		switch args[0] {
		case "proxy":
			serveProxy(site)
			return
		case "shell":
			shell, err := newShell(site)
			if err != nil {
				log.Fatalf("chat page: %v", err)
			}
			serve(site.ShellPort, shell)
			return
		case "dev":
			if err := execDev(site); err != nil {
				log.Fatal(err)
			}
			return
		case "cli":
			args = args[1:]
		}
	}
	if err := runCLI(site, args); err != nil {
		fmt.Fprintln(os.Stderr, "review:", err)
		os.Exit(1)
	}
}

func serveProxy(site Site) {
	store, err := openStore(site.StateDir)
	if err != nil {
		log.Fatalf("notes: %v", err)
	}
	serve(site.AppPort, newApp(site, store))
}

func serve(port int, h http.Handler) {
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 30 * time.Second}
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("listening on :%d", port)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// execDev runs the target's dev server, told its base path.
func execDev(site Site) error {
	t := site.Target
	if t == nil || t.Run == "" {
		return fmt.Errorf("no webReview.target.run")
	}
	env := os.Environ()
	for k, v := range t.Env {
		env = append(env, k+"="+v)
	}
	for k, v := range site.devEnv(t) {
		env = append(env, k+"="+v)
	}
	return syscall.Exec("/bin/sh", []string{"sh", "-c", "exec " + t.Run}, env)
}
