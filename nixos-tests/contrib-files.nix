# nixosTest: contrib/files' sandbox half, booted. The viewer's own behaviour is
# covered by its pytest suite; what only a VM can show is the wiring around it —
# that the contrib's module renders a webservice-files unit, that the unit is
# explicit-start like every other web service, and that the base path the viewer
# serves under is the one the proxy forwards, built from the CONVERSATION_ID that
# reaches the pod on PID 1's environ rather than in the unit's own environment.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-contrib-files";

  nodes.machine = {
    imports = [ sandboxModule ../contrib/files/sandbox.nix ];

    # As the container runtime delivers it: on PID 1's environ, not in the systemd
    # manager environment.
    boot.kernelParams = [ "CONVERSATION_ID=conv-files" ];

    # The viewer reads whatever root it is given; /workspace is a PVC mount in
    # production and an ordinary directory here.
    systemd.tmpfiles.rules = [
      "d /workspace 0755 root root -"
      "d /workspace/docs 0755 root root -"
      "f /workspace/docs/design.md 0644 root root - # hello"
      # tmpfiles' argument is one line, so the fixture is written by its own unit.
      "f /workspace/docs/questions.md 0644 root root -"
      "d /workspace/node_modules 0755 root root -"
    ];
  };

  testScript = ''
    import json

    machine.wait_for_unit("default.target")

    # A document with one live question and one shown inside a fence.
    machine.succeed(
        "cat > /workspace/docs/questions.md <<'EOF'\n"
        "# Asking\n"
        "\n"
        "```\n"
        "<!-- scooter:question id=example kind=text -->\n"
        "Shown, never asked.\n"
        "<!-- /scooter:question -->\n"
        "```\n"
        "\n"
        "<!-- scooter:question id=real kind=single -->\n"
        "Which one is live?\n"
        "- [ ] this one\n"
        "<!-- /scooter:question -->\n"
        "EOF"
    )

    # 1. The contrib's module reaches the discovery manifest the agent-host reads.
    data = json.loads(machine.succeed("cat /run/scooter/web-services.json"))
    svc = {s["name"]: s for s in data["services"]}["files"]
    assert svc["port"] == 7801, svc
    assert svc["unit"] == "webservice-files", svc
    assert svc["basePath"].endswith("/files"), svc
    # The viewer is told its own prefix, so the proxy must NOT strip it: stripping
    # on top of that would 404 every asset.
    assert svc["stripBasePath"] is False, svc

    # 2. Declared costs a manifest entry and no running process.
    machine.fail("systemctl is-active --quiet webservice-files.service")
    machine.succeed("systemctl cat webservice-files.service >/dev/null")

    # 3. Started the way the agent or the Services panel starts it.
    machine.succeed("scooter-service start files")
    machine.wait_for_open_port(7801)

    base = "/c/conv-files/files"

    # 4. It serves under the base path the manifest advertises, and only there —
    # the conversation id came off PID 1's environ, not the unit's environment.
    assert "CONVERSATION_ID" not in machine.succeed("systemctl cat webservice-files.service")
    health = json.loads(machine.succeed(f"curl -fsS http://localhost:7801{base}/api/health"))
    assert health == {"ok": True, "root": "/workspace", "base": base, "frontend": True}, health
    machine.succeed("test $(curl -s -o /dev/null -w '%{http_code}' http://localhost:7801/api/health) = 404")

    # 5. The page is served with its base injected, so its own fetches resolve.
    page = machine.succeed(f"curl -fsS http://localhost:7801{base}/")
    assert "{{BASE}}" not in page, "the base placeholder shipped unsubstituted"
    assert base in page, page[:400]

    # 6. The workspace it lists is the PVC, with the heavy directories flagged
    # rather than walked.
    listing = json.loads(machine.succeed(f"curl -fsS 'http://localhost:7801{base}/api/list?path='"))
    entries = {e["name"]: e for e in listing["entries"]}
    assert entries["docs"]["kind"] == "dir", entries
    assert entries["node_modules"]["skip"] is True, entries

    one = json.loads(machine.succeed(f"curl -fsS 'http://localhost:7801{base}/api/file?path=docs/design.md'"))
    assert one["renderer"] == "markdown", one
    assert "hello" in one["body"], one

    # 6b. The built frontend reaches the unit as a store path. This is the seam the
    # pytest suite cannot cover: there, dist/ is a tmp_path fixture, whereas here it
    # is viewer-ui/ built by Nix and handed over in the unit's environment. Every
    # asset the page links must resolve under the base, or the page is blank.
    import re
    assets = re.findall(r'(?:src|href)="([^"]+/static/[^"]+)"', page)
    assert len(assets) >= 2, page[:400]
    for asset in assets:
        assert asset.startswith(base + "/static/"), asset
        size = int(machine.succeed(
            f"curl -fsS -o /dev/null -w '%{{size_download}}' 'http://localhost:7801{asset}'"
        ).strip())
        assert size > 1024, f"{asset} served {size} bytes"

    # 7. The file tree is read-only: annotations are the only writable surface, so a
    # POST to a read route is refused as 405 rather than being quietly routed.
    machine.succeed(
        "test $(curl -s -o /dev/null -w '%{http_code}' -X POST "
        f"'http://localhost:7801{base}/api/file?path=docs/design.md') = 405"
    )

    # 8. The annotation routes answer, and say which half is deployed: this VM has no
    # broker, so a comment is recorded and reported as never sent rather than lost.
    posted = json.loads(machine.succeed(
        "curl -fsS -X POST -H 'content-type: application/json' "
        """-d '{"path": "docs/design.md", "line": 1, "quote": "hello", "text": "why?"}' """
        f"'http://localhost:7801{base}/api/annotations'"
    ))["annotation"]
    assert posted["state"] in ("pending", "failed", "disabled"), posted
    listed = json.loads(machine.succeed(
        f"curl -fsS 'http://localhost:7801{base}/api/annotations?path=docs/design.md'"
    ))
    assert [a["text"] for a in listed["annotations"]] == ["why?"], listed
    # "hello" is line 1 of the fixture, so the anchor resolved against the file.
    assert listed["annotations"][0]["anchor_state"] == "ok", listed

    # 8a. The wake message's hint works as printed.
    machine.succeed(
        f"CONVERSATION_ID=conv-files scooter-files reply {posted['thread']} 'fixed' --resolve"
    )
    listed = json.loads(machine.succeed(
        f"curl -fsS 'http://localhost:7801{base}/api/annotations?path=docs/design.md'"
    ))
    got = [(a["text"], a["by"], a["resolved"]) for a in listed["annotations"]]
    assert got == [("why?", "reviewer", True), ("fixed", "agent", True)], listed

    # 8b. Question fields come out of the document itself, and an example inside a
    # code fence is syntax being shown rather than a field being asked.
    asked = json.loads(machine.succeed(
        f"curl -fsS 'http://localhost:7801{base}/api/questions?path=docs/questions.md'"
    ))
    assert [f["id"] for f in asked["questions"]] == ["real"], asked
    assert asked["counts"]["open"] == 1, asked

    # 9. `scooter-service start` recorded the intent on the PVC, so a pod recreate
    # brings the viewer back without the user asking twice.
    state = json.loads(machine.succeed("cat /workspace/.scooter/services.json"))
    assert state["enabled"]["files"]["autostart"] is True, state
  '';
}
