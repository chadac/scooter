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
import tomllib


def _warn(what: str, err: BaseException) -> None:
    # Strict: the check fails rather than serve a panel that can't connect.
    if os.environ.get("SCOOTER_MARIMO_STRICT"):
        raise RuntimeError(f"scooter: marimo {what} not patched") from err
    print(f"scooter: marimo {what} not patched ({err!r}); the agent panel may not reach Scooter", file=sys.stderr)


def _user_sets_external_agents(path: str | None) -> bool:
    try:
        with open(path, "rb") as f:
            return "external_agents" in (tomllib.load(f).get("experimental") or {})
    except (OSError, TypeError, tomllib.TOMLDecodeError):
        return False


def _patch() -> None:
    head = os.environ.get("SCOOTER_MARIMO_HEAD", "")
    try:
        from marimo._server import main, start

        create = main.create_starlette_app

        def create_with_head(*args, **kwargs):
            app = create(*args, **kwargs)
            app.state.html_head = head
            return app

        if head:
            main.create_starlette_app = create_with_head
            # Some marimo versions import it into start at module load.
            if getattr(start, "create_starlette_app", None) is create:
                start.create_starlette_app = create_with_head
    except Exception as err:  # noqa: BLE001
        _warn("page head", err)

    try:
        from marimo._config.manager import MarimoConfigManager

        get_overrides = MarimoConfigManager.get_config_overrides

        def overrides_with_agents(self, *args, **kwargs):
            config = get_overrides(self, *args, **kwargs)
            # An override, since the page never sees defaults; the user's own value wins.
            if not _user_sets_external_agents(self.user_config_mgr.get_config_path()):
                config.setdefault("experimental", {}).setdefault("external_agents", True)
            return config

        MarimoConfigManager.get_config_overrides = overrides_with_agents
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
