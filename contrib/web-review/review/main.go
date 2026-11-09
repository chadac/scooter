// scooter-review: the web app review service (contrib/web-review).
//
//	scooter-review proxy   the review-app unit: the dev server behind a rewriting proxy, and the notes API
//	scooter-review shell   the review unit: the chat beside the app
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
			serve(site.ShellPort, newShell(site), nil)
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
	app := newApp(site, store)
	app.current() // starts a --run dev server without waiting for a visit
	serve(site.AppPort, app, app.stopDev)
}

func serve(port int, h http.Handler, onStop func()) {
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 30 * time.Second}
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		if onStop != nil {
			onStop()
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("listening on :%d", port)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
