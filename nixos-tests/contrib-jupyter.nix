# nixosTest: contrib/jupyter's wiring; kernels and the MCP server need PyPI.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-contrib-jupyter";

  nodes.machine = {
    imports = [ sandboxModule ../contrib/jupyter/sandbox.nix ];
    # Delivered on PID 1's environ, as in a pod.
    boot.kernelParams = [ "CONVERSATION_ID=conv-jup" "CONVERSATION_URL=https://app.example/?thread=conv-jup" ];
    systemd.tmpfiles.rules = [ "d /workspace 0755 root root -" ];
    environment.systemPackages = [ pkgs.curl pkgs.jq ];
    virtualisation.memorySize = 2048;
  };

  testScript = ''
    import json

    lab = "http://localhost:2719/c/conv-jup/jupyter"

    machine.wait_for_unit("default.target")

    # Listed and explicit-start, MCP server included.
    data = {s["name"]: s for s in json.loads(machine.succeed("cat /run/scooter/web-services.json"))["services"]}
    assert data["jupyter"]["port"] == 2719, data["jupyter"]
    mcp = {s["name"]: s for s in json.loads(machine.succeed("cat /run/scooter/mcp-servers.json"))["servers"]}
    assert mcp["jupyter"]["autoStart"] is False, mcp["jupyter"]
    machine.fail("systemctl is-active webservice-jupyter")

    machine.succeed("scooter-service start jupyter")
    machine.wait_for_unit("webservice-jupyter.service")
    machine.wait_until_succeeds(f"curl -fsS {lab}/api/status", timeout=120)
    assert "mcp-jupyter.service" in machine.succeed("systemctl show -p Wants --value webservice-jupyter")

    # Both kernels, per-notebook by default.
    specs = json.loads(machine.succeed(f"curl -fsS {lab}/api/kernelspecs"))
    assert specs["default"] == "python3", specs["default"]
    names = {k: v["spec"]["display_name"] for k, v in specs["kernelspecs"].items()}
    assert names == {"python3": "Python (notebook)", "python-workspace": "Python (workspace)"}, names

    # Sidebar extension, chat URL, and framing limited to the app.
    page = machine.succeed(f"curl -fsS -D /tmp/headers {lab}/lab")
    assert '"scooterChatUrl": "https://app.example/chat/conv-jup"' in page, page[:2000]
    assert "scooter-jupyter-chat" in page, page[:2000]
    headers = machine.succeed("cat /tmp/headers").lower()
    assert "frame-ancestors 'self' https://app.example" in headers, headers

    news = json.loads(machine.succeed(
        f"curl -fsS {lab}/lab/api/settings/@jupyterlab/apputils-extension:notification"
    ))
    assert news["schema"]["properties"]["fetchNews"]["default"] == "false", news["schema"]
  '';
}
