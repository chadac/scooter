"""Acme Ops, the web review sample app: a dashboard SPA under a base path.

    python3 serve.py --port 5173 --base /review-app/

Static files, a small JSON API and an SPA fallback, all under --base (default
$REVIEW_BASE, else /). It sends X-Frame-Options: DENY and a CSP, as a real app
might, so the review proxy's header handling is exercised.
"""

import argparse
import json
import os
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).parent

ORDERS = [
    {"id": 1042, "customer": "Globex", "total": 1204.50, "status": "late", "items": 3},
    {"id": 1041, "customer": "Initech", "total": 89.99, "status": "shipped", "items": 1},
    {"id": 1040, "customer": "Umbrella", "total": 4310.00, "status": "processing", "items": 12},
    {"id": 1039, "customer": "Hooli", "total": 250.00, "status": "shipped", "items": 2},
    {"id": 1038, "customer": "Globex", "total": 760.25, "status": "delivered", "items": 5},
    {"id": 1037, "customer": "Stark Industries", "total": 15999.00, "status": "delivered", "items": 40},
]
CUSTOMERS = [
    {"name": "Globex", "orders": 2, "since": "2019"},
    {"name": "Hooli", "orders": 1, "since": "2021"},
    {"name": "Initech", "orders": 1, "since": "2018"},
    {"name": "Stark Industries", "orders": 1, "since": "2016"},
    {"name": "Umbrella", "orders": 1, "since": "2022"},
]
STATS = {"revenue": 22613.74, "orders": len(ORDERS), "late": 1, "trend": [12, 18, 15, 22, 19, 27, 31, 26, 34, 38]}


def make_handler(base: str):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(HERE / "static"), **kwargs)

        def end_headers(self):
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
            self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def log_message(self, fmt, *args):
            pass

        def send_json(self, data, status=HTTPStatus.OK):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_index(self):
            html = (HERE / "static" / "index.html").read_text().replace("@BASE@", base)
            body = html.encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path + "/" == base:
                self.send_response(HTTPStatus.MOVED_PERMANENTLY)
                self.send_header("Location", base)
                self.end_headers()
                return
            if not path.startswith(base):
                self.send_error(HTTPStatus.NOT_FOUND, "outside the app's base path")
                return
            rest = "/" + path[len(base):]
            if rest == "/api/stats":
                return self.send_json(STATS)
            if rest == "/api/orders":
                return self.send_json(ORDERS)
            if rest.startswith("/api/orders/"):
                order = next((o for o in ORDERS if str(o["id"]) == rest.rsplit("/", 1)[1]), None)
                return self.send_json(order or {"error": "not found"}, HTTPStatus.OK if order else HTTPStatus.NOT_FOUND)
            if rest == "/api/customers":
                return self.send_json(CUSTOMERS)
            if rest.startswith("/assets/"):
                self.path = rest
                return super().do_GET()
            # Every other path is a client-side route.
            return self.send_index()

    return Handler


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5173")))
    p.add_argument("--base", default=os.environ.get("REVIEW_BASE", "/"))
    args = p.parse_args()
    base = "/" + args.base.strip("/") + "/" if args.base.strip("/") else "/"
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(base))
    print(f"Acme Ops on http://localhost:{args.port}{base}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
