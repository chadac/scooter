"""`marimo` with its Agent panel wired to this conversation.

Run in marimo's own environment as `python launch.py edit ...`. Before marimo's CLI starts it:
- puts $SCOOTER_MARIMO_HEAD (agent-panel.js) into every notebook page's <head>, through
  marimo's own `html_head`, which `marimo edit` never sets;
- turns on `experimental.external_agents` unless the user's marimo.toml sets it, so an
  explicit false there still turns the panel off;
- has `--sandbox`'s server relaunch run this file again rather than `-m marimo`.

These touch marimo internals, so each degrades to plain marimo if marimo changes.
"""

import os
import sys


def _warn(what: str, err: BaseException) -> None:
    print(f"scooter: marimo {what} not patched ({err!r}); the agent panel may not reach Scooter", file=sys.stderr)


def _patch() -> None:
    head = os.environ.get("SCOOTER_MARIMO_HEAD", "")
    try:
        from marimo._server import start

        create = start.create_starlette_app

        def create_with_head(*args, **kwargs):
            app = create(*args, **kwargs)
            app.state.html_head = head
            return app

        if head:
            start.create_starlette_app = create_with_head
    except Exception as err:  # noqa: BLE001
        _warn("page head", err)

    try:
        from marimo._config.manager import MarimoConfigManager

        read_overrides = MarimoConfigManager._read_overrides

        def overrides_with_agents(self):
            config = read_overrides(self)
            # An override, since the page never sees defaults; the user's own value wins.
            user = self.user_config_mgr.read().get("experimental") or {}
            if "external_agents" not in user:
                config.setdefault("experimental", {}).setdefault("external_agents", True)
            return config

        MarimoConfigManager._read_overrides = overrides_with_agents
    except Exception as err:  # noqa: BLE001
        _warn("settings", err)

    try:
        from marimo._environments import backends

        launch_server = backends.launch_server

        def relaunch_here(args, **kwargs):
            args = list(args)
            if args[:2] == ["-m", "marimo"]:
                args = [os.path.abspath(__file__), *args[2:]]
            return launch_server(args, **kwargs)

        backends.launch_server = relaunch_here
    except Exception as err:  # noqa: BLE001
        _warn("sandbox relaunch", err)


if __name__ == "__main__":
    _patch()
    from marimo._cli.cli import main

    sys.argv[0] = "marimo"
    sys.exit(main())
