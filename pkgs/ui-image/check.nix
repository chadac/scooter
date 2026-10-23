{ pkgs }:

# The UI's nginx config, rendered by the image's own `render` and served for real: who may
# frame which page. Only `/chat/<id>` may be framed, and only by that conversation's own
# sandbox origin (or 'self' without a sandbox domain); every other UI route, by nothing.

let
  ui = pkgs.runCommand "ui-stub" { } ''
    mkdir -p $out
    echo '<!doctype html><title>scooter-ui-stub</title>' > $out/index.html
  '';
  conf = import ./nginx.nix { inherit pkgs ui; };
  id = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff";
in
pkgs.runCommand "ui-nginx-frame-ancestors"
{
  nativeBuildInputs = [ pkgs.curl pkgs.nginx pkgs.gnused pkgs.gnugrep ];
} ''
  set -euo pipefail
  fail=0

  # Render as the container would, then point the writable paths at $TMPDIR.
  serve() { # serve <name> <port> [SANDBOX_DOMAIN] [CONTRIB_MANIFEST_FILE]
    local dir=$TMPDIR/$1
    mkdir -p $dir
    env -i PATH="$PATH" AGENT_HOST_URL=http://127.0.0.1:1 BROKER_URL=http://127.0.0.1:1 \
      ''${3:+SANDBOX_DOMAIN=$3} ''${4:+CONTRIB_MANIFEST_FILE=$4} ${conf.render} $dir/rendered.conf
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

  kill $(cat $TMPDIR/sandbox/nginx.pid) $(cat $TMPDIR/shared/nginx.pid) || true
  [ $fail = 0 ] || exit 1
  touch $out
''
