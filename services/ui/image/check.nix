{ pkgs }:

# The UI's nginx config, rendered by the image's own `render` and served for real: who may
# frame which page. Only `/chat/<id>` may be framed, and only by that conversation's own
# sandbox origin (or 'self' without a sandbox domain); every other UI route, by nothing.
# Also the /agui body limit (UPLOAD_MAX_BODY, derived from scooter.uploads).
# Also that the image's stop signal drains open SSE streams.

let
  ui = pkgs.runCommand "ui-stub" { } ''
    mkdir -p $out/assets
    echo '<!doctype html><title>scooter-ui-stub</title>' > $out/index.html
    echo '{"build":"stub"}' > $out/version.json
    echo 'export {}' > $out/assets/index-stub.js
  '';
  conf = import ./nginx.nix { inherit pkgs ui; };
  id = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff";
  # Sends `chunks` SSE events then ends; 0 streams forever.
  sseUpstream = pkgs.writeText "sse-upstream.py" ''
    import http.server, sys, time
    port, chunks = int(sys.argv[1]), int(sys.argv[2])
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *a): pass
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            i = 0
            while chunks == 0 or i < chunks:
                ev = f"data: {i}\n\n".encode()
                self.wfile.write(b"%x\r\n%s\r\n" % (len(ev), ev)); self.wfile.flush()
                i += 1; time.sleep(0.5)
            ev = b"data: done\n\n"
            self.wfile.write(b"%x\r\n%s\r\n0\r\n\r\n" % (len(ev), ev)); self.wfile.flush()
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
  '';
in
pkgs.runCommand "ui-nginx-frame-ancestors"
{
  nativeBuildInputs = [ pkgs.curl pkgs.nginx pkgs.gnused pkgs.gnugrep pkgs.python3 ];
} ''
  set -euo pipefail
  fail=0

  # Render as the container would, then point the writable paths at $TMPDIR.
  serve() { # serve <name> <port> [SANDBOX_DOMAIN] [CONTRIB_MANIFEST_FILE] [UPLOAD_MAX_BODY]
    local dir=$TMPDIR/$1
    mkdir -p $dir
    env -i PATH="$PATH" AGENT_HOST_URL="''${AGENT_HOST_URL:-http://127.0.0.1:1}" BROKER_URL=http://127.0.0.1:1 \
      ''${SHUTDOWN_TIMEOUT:+SHUTDOWN_TIMEOUT=$SHUTDOWN_TIMEOUT} \
      ''${3:+SANDBOX_DOMAIN=$3} ''${4:+CONTRIB_MANIFEST_FILE=$4} ''${5:+UPLOAD_MAX_BODY=$5} \
      ${conf.render} $dir/rendered.conf
    sed -e "s|pid /var/run/nginx.pid;|pid $dir/nginx.pid;|" \
        -e "s|listen 8080;|listen 127.0.0.1:$2;|" \
        -e "s|access_log /dev/stdout;|access_log off;|" \
        -e "s|error_log /dev/stderr warn;|error_log $dir/error.log warn;|" \
        -e "s|^http {|http { client_body_temp_path $dir/cb; proxy_temp_path $dir/px; fastcgi_temp_path $dir/fc; uwsgi_temp_path $dir/uw; scgi_temp_path $dir/sc;|" \
        $dir/rendered.conf > $dir/nginx.conf
    nginx -e $dir/error.log -p $dir -c $dir/nginx.conf
    for _ in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:$2/ && return 0; sleep 0.1; done
    cat $dir/error.log; exit 1
  }

  # expect <port> <path> <frame-ancestors value, or "absent">
  expect() {
    local got
    got=$(curl -s -D - -o /dev/null "http://127.0.0.1:$1$2" | tr -d '\r' \
      | sed -n 's/^[Cc]ontent-[Ss]ecurity-[Pp]olicy: frame-ancestors //p')
    [ -n "$got" ] || got=absent
    if [ "$got" = "$3" ]; then echo "ok   $2 -> $got"; else echo "FAIL $2 -> $got (want $3)"; fail=1; fi
  }

  # The deployment's contrib manifest, as modules/platform.nix mounts it.
  # nginx's workers run as nobody, so the file must be readable the way a ConfigMap's is.
  mkdir -p $TMPDIR/mount && chmod 755 $TMPDIR $TMPDIR/mount
  echo '{"settingsTabs":{"mounted":{}}}' > $TMPDIR/mount/manifest.json && chmod 644 $TMPDIR/mount/manifest.json
  serve sandbox 18081 sbx.example.com $TMPDIR/mount/manifest.json
  # The subpage: framed by its own sandbox origin only, however the path is spelled.
  expect 18081 "/chat/${id}" "https://5a515e73.sbx.example.com"
  expect 18081 "/chat/${id}/" "https://5a515e73.sbx.example.com"
  expect 18081 "/chat/${id}?embed=1" "https://5a515e73.sbx.example.com"
  # It still serves the app (the SPA fallback), not a 404.
  curl -sf "http://127.0.0.1:18081/chat/${id}" | grep -q scooter-ui-stub || { echo "FAIL /chat/<id> does not serve the app"; fail=1; }
  # Everything else in the UI: never framed.
  expect 18081 "/" "'none'"
  expect 18081 "/?thread=${id}" "'none'"
  expect 18081 "/settings/tasks" "'none'"
  expect 18081 "/index.html" "'none'"
  expect 18081 "/chat/${id}/extra" "'none'"
  expect 18081 "/chat/not-a-uuid" "'none'"
  expect 18081 "/chat/5A515E73-860B-49BA-BC3F-6FF8D5FDA5FF" "'none'"
  expect 18081 "/x/chat/${id}" "'none'"
  # A query naming a /chat/ path doesn't count.
  expect 18081 "/?next=/chat/${id}" "'none'"

  serve shared 18082
  # Without a sandbox domain, services share the UI's origin.
  expect 18082 "/chat/${id}" "'self'"
  expect 18082 "/" "'none'"

  # /contrib/manifest.json: the mounted file when the deployment provides one (so its
  # disabled contribs show no tab), else the image's built-in one ({} here).
  manifest() { # manifest <port> <want body>
    local got; got=$(curl -sf "http://127.0.0.1:$1/contrib/manifest.json" || echo "<error>")
    if [ "$got" = "$2" ]; then echo "ok   manifest :$1 -> $got"; else echo "FAIL manifest :$1 -> $got (want $2)"; fail=1; fi
  }
  manifest 18081 '{"settingsTabs":{"mounted":{}}}'
  manifest 18082 '{}'
  curl -s -D - -o /dev/null http://127.0.0.1:18082/contrib/manifest.json | grep -qi "^content-type: application/json" \
    || { echo "FAIL /contrib/manifest.json is not served as JSON"; fail=1; }

  # /agui body limit. The upstream is unreachable, so a body nginx accepts gets a 502;
  # one over client_max_body_size gets a 413 before it is proxied.
  upload() { # upload <port> <MiB> <want status>
    head -c $(( $2 * 1024 * 1024 )) /dev/zero > $TMPDIR/body
    local got; got=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
      -H 'content-type: application/json' --data-binary @$TMPDIR/body "http://127.0.0.1:$1/agui")
    if [ "$got" = "$3" ]; then echo "ok   /agui $2MiB -> $got"; else echo "FAIL /agui $2MiB -> $got (want $3)"; fail=1; fi
  }
  serve uploads 18083 "" "" 10m
  upload 18083 5 502
  upload 18083 12 413
  # Without UPLOAD_MAX_BODY the render default matches the platform's default
  # (4 x 25MB). Checked in the rendered text rather than with a ~140MB request; this
  # also catches UPLOAD_MAX_BODY missing from envsubst's variable list.
  grep -q 'client_max_body_size 144m;' $TMPDIR/shared/rendered.conf \
    || { echo "FAIL default render lacks client_max_body_size 144m"; grep -n client_max_body_size $TMPDIR/shared/rendered.conf; fail=1; }
  grep -q 'client_max_body_size 10m;' $TMPDIR/uploads/rendered.conf \
    || { echo "FAIL UPLOAD_MAX_BODY=10m not rendered"; fail=1; }

  # Contribs' public broker paths: proxied only when the manifest lists them.
  echo '{"brokerPublicPaths":["/s/"]}' > $TMPDIR/mount/paths.json && chmod 644 $TMPDIR/mount/paths.json
  serve paths 18084 "" $TMPDIR/mount/paths.json
  got=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18084/s/abc/)
  [ "$got" = 502 ] && echo "ok   /s/ proxied -> $got" || { echo "FAIL /s/ with publicPaths -> $got (want 502)"; fail=1; }
  curl -sf http://127.0.0.1:18081/s/abc/ | grep -q scooter-ui-stub \
    && echo "ok   /s/ unlisted -> SPA" || { echo "FAIL /s/ without publicPaths is still proxied"; fail=1; }

  # API prefixes reach the dead upstream (502), not the SPA.
  proxied() { # proxied <method> <path>
    local got; got=$(curl -s -o /dev/null -w '%{http_code}' -X "$1" "http://127.0.0.1:18082$2")
    if [ "$got" = 502 ]; then echo "ok   $1 $2 proxied"; else echo "FAIL $1 $2 -> $got (want 502)"; fail=1; fi
  }
  proxied GET /user-hooks
  proxied PATCH /user-hooks/h1
  proxied GET /user-skills
  proxied GET /sandbox-sizes

  # Shell revalidates, hashed assets cache forever, missing ones 404.
  header() { # header <path> <want Cache-Control>
    local got; got=$(curl -s -D - -o /dev/null "http://127.0.0.1:18082$1" | tr -d '\r' \
      | sed -n 's/^[Cc]ache-[Cc]ontrol: //p')
    if [ "$got" = "$2" ]; then echo "ok   $1 -> $got"; else echo "FAIL $1 Cache-Control -> $got (want $2)"; fail=1; fi
  }
  header / "no-cache"
  header /index.html "no-cache"
  header "/?thread=${id}" "no-cache"
  header /version.json "no-cache"
  header /assets/index-stub.js "public, max-age=31536000, immutable"
  got=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18082/assets/index-gone.js)
  [ "$got" = 404 ] && echo "ok   missing asset -> 404" || { echo "FAIL missing asset -> $got (want 404)"; fail=1; }

  upstream() { # upstream <port> <chunks>; the pid lands in $up
    python3 ${sseUpstream} $1 $2 & up=$!
    for _ in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/$1) 2>/dev/null && return 0; sleep 0.1; done
    echo "upstream :$1 never listened"; exit 1
  }

  # A mid-stream stop still ends the response cleanly (curl exits 0).
  upstream 18090 6
  AGENT_HOST_URL=http://127.0.0.1:18090 serve drain 18085
  curl -sSN http://127.0.0.1:18085/conversations/c1/events.integrity > $TMPDIR/stream & c=$!
  sleep 1
  kill -s ${conf.stopSignal} $(cat $TMPDIR/drain/nginx.pid)
  if wait $c && grep -q "data: done" $TMPDIR/stream; then echo "ok   stream drains on ${conf.stopSignal}"
  else echo "FAIL stream cut on ${conf.stopSignal}"; cat $TMPDIR/stream; fail=1; fi
  kill $up

  # An endless stream holds nginx only until SHUTDOWN_TIMEOUT.
  upstream 18091 0
  AGENT_HOST_URL=http://127.0.0.1:18091 SHUTDOWN_TIMEOUT=2s serve forever 18086
  curl -sN http://127.0.0.1:18086/conversations/c1/events.integrity > /dev/null & c=$!
  sleep 1
  pid=$(cat $TMPDIR/forever/nginx.pid)
  kill -s ${conf.stopSignal} $pid
  for _ in $(seq 50); do kill -0 $pid 2>/dev/null || break; sleep 0.1; done
  if kill -0 $pid 2>/dev/null; then echo "FAIL nginx outlives SHUTDOWN_TIMEOUT"; kill -9 $pid $c; fail=1
  else echo "ok   nginx exits after SHUTDOWN_TIMEOUT"; fi
  wait $c || true
  kill $up

  kill $(cat $TMPDIR/sandbox/nginx.pid) $(cat $TMPDIR/shared/nginx.pid) $(cat $TMPDIR/uploads/nginx.pid) $(cat $TMPDIR/paths/nginx.pid) || true
  [ $fail = 0 ] || exit 1
  touch $out
''
