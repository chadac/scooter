"""marimo-open: start a notebook's kernel without a browser, run it, then detach.

marimo keeps a detached session: marimo-pair can drive it, and a browser that
opens the notebook later resumes the same kernel as its editor. Staying
connected would instead push that browser into read-only kiosk mode.
"""

import argparse
import asyncio
import json
import os
import re
import sys
import urllib.request
import uuid
from urllib.parse import urlencode

import websockets

PORT = "@port@"
BUSY = ("queued", "running")


def default_url() -> str:
    # Same base path as the scooter-marimo skill's $MARIMO_BASE.
    if os.environ.get("SCOOTER_SERVICES_ORIGIN"):
        base = "/notebook"
    else:
        base = f"/c/{os.environ.get('CONVERSATION_ID', 'unknown')}/notebook"
    return f"http://localhost:{PORT}{base}"


def get(url: str) -> str:
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read().decode()


def session_for(base: str, path: str) -> str | None:
    for sid, session in json.loads(get(f"{base}/api/sessions")).items():
        if session.get("path") == path:
            return sid
    return None


def instantiate(base: str, sid: str) -> None:
    # A --no-token server still checks this per-server token on POSTs.
    match = re.search(r'data-token="([^"]*)"', get(f"{base}/"))
    if match is None:
        raise RuntimeError("no server token on marimo's home page")
    req = urllib.request.Request(
        f"{base}/api/kernel/instantiate",
        data=json.dumps({"objectIds": [], "values": [], "autoRun": True}).encode(),
        headers={
            "Marimo-Session-Id": sid,
            "Marimo-Server-Token": match.group(1),
            "Content-Type": "application/json",
        },
        method="POST",
    )
    urllib.request.urlopen(req, timeout=30).read()


async def open_detached(base: str, path: str, timeout: float) -> str:
    sid = "agent-" + uuid.uuid4().hex[:8]
    query = urlencode({"session_id": sid, "file": path})
    url = base.replace("http", "ws", 1) + "/ws?" + query
    cells: list[str] = []
    busy: set[str] = set()
    ran = False

    async def pump(until) -> None:
        nonlocal ran
        while True:
            msg = json.loads(await ws.recv())
            op, data = msg.get("op"), msg.get("data") or {}
            if op == "kernel-ready":
                cells.extend(data.get("cell_ids") or [])
            elif op == "cell-op" and data.get("status"):
                if data["status"] in BUSY:
                    busy.add(data["cell_id"])
                    ran = True
                else:
                    busy.discard(data["cell_id"])
            if until(op):
                return

    async with websockets.connect(url, max_size=None) as ws:
        # The first open of a --sandbox notebook builds its environment.
        await asyncio.wait_for(pump(lambda op: op == "kernel-ready"), timeout)
        instantiate(base, sid)
        if not cells:
            return sid
        # Detach once cells go idle, so the first pair call sees full globals.
        try:
            await asyncio.wait_for(pump(lambda op: ran and not busy), timeout)
        except asyncio.TimeoutError:
            print("marimo-open: cells still running; detaching anyway", file=sys.stderr)
    return sid


def main() -> None:
    parser = argparse.ArgumentParser(prog="marimo-open", description=__doc__)
    parser.add_argument("notebook")
    parser.add_argument("--url", default=default_url(), help="marimo server URL, with its base path")
    parser.add_argument("--timeout", type=float, default=600, help="seconds to wait at each step")
    args = parser.parse_args()
    base, path = args.url.rstrip("/"), os.path.abspath(args.notebook)
    if not os.path.isfile(path):
        sys.exit(f"marimo-open: {path}: no such notebook")
    try:
        if sid := session_for(base, path):
            print(f"already running: {sid}")
            return
        sid = asyncio.run(open_detached(base, path, args.timeout))
    except Exception as err:  # noqa: BLE001
        sys.exit(f"marimo-open: couldn't start a session for {path} at {base}: {err!r}")
    print(f"started: {sid} ({path})")


if __name__ == "__main__":
    main()
