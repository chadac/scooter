"""`scooter-files`: answer review threads from the agent's shell.

Talks to the running viewer in the pod, so a reply goes through the same anchor
checks and broker outbox as one typed in the browser. Stdlib only, like the viewer.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def base_url(env: dict[str, str]) -> str:
    """The viewer's in-pod URL, under the prefix the proxy forwards."""
    prefix = env.get("SCOOTER_SERVICE_PREFIX")
    if prefix is None:
        # Without a services origin, services live under /c/<id>/.
        conv = env.get("CONVERSATION_ID", "")
        prefix = f"/c/{conv}" if conv and not env.get("SCOOTER_SERVICES_ORIGIN") else ""
    port = env.get("SCOOTER_FILES_PORT", "7801")
    return f"http://127.0.0.1:{port}{prefix}/files"


def post(base: str, route: str, body: dict) -> dict:
    request = urllib.request.Request(
        base + route,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read()).get("error", "")
        except ValueError:
            detail = ""
        raise SystemExit(f"scooter-files: {exc.code} {detail or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(
            f"scooter-files: the viewer is not reachable ({exc.reason}); "
            "start it with `scooter-service start files`"
        ) from exc


def thread_route(thread: str, verb: str) -> str:
    return f"/api/annotations/threads/{urllib.parse.quote(thread, safe='')}/{verb}"


def main(argv: list[str] | None = None, env: dict[str, str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="scooter-files", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    reply = sub.add_parser("reply", help="reply in a thread, shown as Scooter")
    reply.add_argument("thread")
    reply.add_argument("text")
    reply.add_argument("--resolve", action="store_true", help="resolve the thread too")
    resolve = sub.add_parser("resolve", help="resolve a thread")
    resolve.add_argument("thread")
    resolve.add_argument("--reopen", action="store_true", help="reopen it instead")
    args = parser.parse_args(argv)

    base = base_url(dict(os.environ) if env is None else env)
    if args.command == "reply":
        post(base, thread_route(args.thread, "reply"), {"text": args.text, "by": "agent"})
        print(f"replied in {args.thread}")
    if args.command == "resolve" or args.resolve:
        resolved = not getattr(args, "reopen", False)
        post(base, thread_route(args.thread, "resolve"), {"resolved": resolved})
        print(f"{'resolved' if resolved else 'reopened'} {args.thread}")


if __name__ == "__main__":
    main(sys.argv[1:])
