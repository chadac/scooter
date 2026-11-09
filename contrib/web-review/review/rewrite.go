package main

import (
	"bytes"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Rewriter maps localhost:<port> URLs onto the public origin.
type Rewriter struct {
	re *regexp.Regexp
}

func newRewriter(port int) *Rewriter {
	p := strconv.Itoa(port)
	return &Rewriter{re: regexp.MustCompile(`(?i)\b(https?|wss?)://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):` + p + `\b`)}
}

func (r *Rewriter) Bytes(b []byte, public *url.URL) []byte {
	if public == nil {
		return b
	}
	return r.re.ReplaceAllFunc(b, func(m []byte) []byte {
		scheme := strings.ToLower(string(m[:bytes.Index(m, []byte("://"))]))
		if scheme == "ws" || scheme == "wss" {
			scheme = "ws"
			if public.Scheme == "https" {
				scheme = "wss"
			}
		} else {
			scheme = public.Scheme
		}
		return []byte(scheme + "://" + public.Host)
	})
}

func (r *Rewriter) String(s string, public *url.URL) string {
	return string(r.Bytes([]byte(s), public))
}

// IsLocal reports whether an origin is the dev server's own.
func (r *Rewriter) IsLocal(origin string) bool {
	return r.re.MatchString(origin) && r.re.FindStringIndex(origin)[1] == len(strings.TrimRight(origin, "/"))
}

var (
	cspDirective = regexp.MustCompile(`\s*;\s*`)
	metaCSP      = regexp.MustCompile(`(?is)(<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*content\s*=\s*)("[^"]*"|'[^']*')`)
	metaCSPFirst = regexp.MustCompile(`(?is)(<meta[^>]+content\s*=\s*)("[^"]*"|'[^']*')([^>]*http-equiv\s*=\s*["']?content-security-policy)`)
	headOpen     = regexp.MustCompile(`(?is)<head(\s[^>]*)?>`)
	htmlOpen     = regexp.MustCompile(`(?is)<html(\s[^>]*)?>`)
	doctype      = regexp.MustCompile(`(?is)^\s*<!doctype[^>]*>`)
)

// relaxCSP drops frame-ancestors and lets the overlay's requests through.
func relaxCSP(policy string) string {
	var out []string
	for _, d := range cspDirective.Split(strings.TrimSpace(policy), -1) {
		fields := strings.Fields(d)
		if len(fields) == 0 {
			continue
		}
		name := strings.ToLower(fields[0])
		switch name {
		case "frame-ancestors":
			continue
		case "script-src", "script-src-elem", "connect-src", "default-src", "img-src":
			if !hasToken(fields[1:], "'self'") && !hasToken(fields[1:], "'strict-dynamic'") {
				fields = append(fields, "'self'")
			}
			if name == "img-src" || name == "default-src" {
				for _, t := range []string{"data:", "blob:"} {
					if !hasToken(fields[1:], t) {
						fields = append(fields, t)
					}
				}
			}
			fields = dropToken(fields, "'none'")
		}
		out = append(out, strings.Join(fields, " "))
	}
	return strings.Join(out, "; ")
}

func hasToken(fields []string, t string) bool {
	for _, f := range fields {
		if strings.EqualFold(f, t) {
			return true
		}
	}
	return false
}

func dropToken(fields []string, t string) []string {
	out := fields[:1]
	for _, f := range fields[1:] {
		if !strings.EqualFold(f, t) {
			out = append(out, f)
		}
	}
	return out
}

// relaxMetaCSP applies relaxCSP to CSP <meta> tags.
func relaxMetaCSP(html []byte) []byte {
	fix := func(attr []byte) []byte {
		q := attr[0]
		return append(append([]byte{q}, relaxCSP(string(attr[1:len(attr)-1]))...), q)
	}
	html = metaCSP.ReplaceAllFunc(html, func(m []byte) []byte {
		sub := metaCSP.FindSubmatch(m)
		return append(append([]byte{}, sub[1]...), fix(sub[2])...)
	})
	return metaCSPFirst.ReplaceAllFunc(html, func(m []byte) []byte {
		sub := metaCSPFirst.FindSubmatch(m)
		return append(append(append([]byte{}, sub[1]...), fix(sub[2])...), sub[3]...)
	})
}

// inject goes first in <head>, before the app's own scripts.
func inject(html []byte, tag string) []byte {
	for _, re := range []*regexp.Regexp{headOpen, htmlOpen, doctype} {
		if loc := re.FindIndex(html); loc != nil {
			out := make([]byte, 0, len(html)+len(tag))
			out = append(out, html[:loc[1]]...)
			out = append(out, tag...)
			return append(out, html[loc[1]:]...)
		}
	}
	return append([]byte(tag), html...)
}
