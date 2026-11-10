# Mirrors marimo: mkDefault only, never gated on `cfg.enable`.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.jupyter;
  # uv fetches this pin on first start.
  mcpVersion = "2.2.5";

  serverEnv = pkgs.python3.withPackages (ps: [ ps.jupyterlab ps.jupyter-collaboration ]);
  chatExtension = pkgs.callPackage ./ext { };

  # A downloaded CPython cannot exec on NixOS.
  uvEnv = {
    UV_PYTHON = "${pkgs.python3}/bin/python3";
    UV_PYTHON_DOWNLOADS = "never";
  };

  basePath = ''"''${SCOOTER_SERVICE_PREFIX-/c/''${CONVERSATION_ID:-unknown}}/jupyter"'';

  # Per-notebook kernel: the notebook's `# /// script` cell is its requirements (juv's layout).
  notebookKernel = pkgs.writeShellScript "jupyter-kernel-notebook" ''
    set -euo pipefail
    conn="$1"
    nb="''${JPY_SESSION_NAME:-}"
    # jupyter-mcp-server starts kernels before their session exists.
    if [ -z "$nb" ]; then
      kid="$(${pkgs.coreutils}/bin/basename "$conn" .json)"; kid="''${kid#kernel-}"
      api="http://127.0.0.1:${toString cfg.port}"${basePath}"/api/sessions"
      for _ in $(${pkgs.coreutils}/bin/seq 120); do
        nb="$(${pkgs.curl}/bin/curl -fsS "$api" 2>/dev/null \
          | ${pkgs.jq}/bin/jq -r --arg k "$kid" 'map(select(.kernel.id == $k))[0].path // empty' || true)"
        [ -n "$nb" ] && break
        sleep 0.25
      done
    fi
    case "$nb" in ""|/*) ;; *) nb="/workspace/$nb" ;; esac
    args=(--no-project --with ipykernel)
    if [ -n "$nb" ] && [ -f "$nb" ]; then
      req="$(${pkgs.coreutils}/bin/mktemp --suffix .py)"
      ${pkgs.jq}/bin/jq -r '
        [.cells[] | select(.cell_type == "code") | (.source | if type == "array" then join("") else . end)
         | select(test("^# /// script"; "m"))] | first // empty' "$nb" > "$req"
      if [ -s "$req" ]; then args+=(--with-requirements "$req"); fi
    fi
    exec ${pkgs.uv}/bin/uv run "''${args[@]}" python -m ipykernel_launcher -f "$conn"
  '';

  # One shared seeded venv, so %pip works.
  workspaceKernel = pkgs.writeShellScript "jupyter-kernel-workspace" ''
    set -euo pipefail
    venv=/workspace/.jupyter/venv
    if [ ! -x "$venv/bin/python" ]; then
      ${pkgs.uv}/bin/uv venv --seed "$venv"
      ${pkgs.uv}/bin/uv pip install --python "$venv/bin/python" ipykernel
    fi
    exec "$venv/bin/python" -m ipykernel_launcher -f "$1"
  '';

  kernelSpec = name: display: launcher: pkgs.writeTextDir "share/jupyter/kernels/${name}/kernel.json"
    (builtins.toJSON {
      argv = [ "${launcher}" "{connection_file}" ];
      display_name = display;
      language = "python";
      metadata.debugger = true;
    });

  # No news or update popups.
  labSettings = pkgs.writeTextDir "overrides.json" (builtins.toJSON {
    "@jupyterlab/apputils-extension:notification" = { fetchNews = "false"; checkForUpdates = false; };
  });

  jupyterData = pkgs.symlinkJoin {
    name = "scooter-jupyter-data";
    paths = [
      # Shadows the server env's ipykernel, which clients request by name.
      (kernelSpec "python3" "Python (notebook)" notebookKernel)
      (kernelSpec "python-workspace" "Python (workspace)" workspaceKernel)
      chatExtension
    ];
  };

  labServer = pkgs.writeShellScript "jupyter-web-service" ''
    set -euo pipefail
    base=${basePath}
    origin="$(printf %s "''${CONVERSATION_URL:-}" | ${pkgs.gnused}/bin/sed -n 's|^\(https\{0,1\}://[^/]*\).*|\1|p')"
    chat="''${SCOOTER_CHAT_URL:-}"
    if [ -z "$chat" ] && [ -n "$origin" ] && [ -n "''${CONVERSATION_ID:-}" ]; then
      chat="$origin/chat/$CONVERSATION_ID"
    fi
    # The sidebar's chat URL, and who may frame lab.
    conf="''${RUNTIME_DIRECTORY%%:*}/config"
    mkdir -p "$conf/labconfig" /workspace/.jupyter
    ${pkgs.jq}/bin/jq -n --arg c "$chat" '{scooterChatUrl: $c}' > "$conf/labconfig/page_config.json"
    ${pkgs.jq}/bin/jq -n --arg o "$origin" '{ServerApp: {tornado_settings: {headers: {
      "Content-Security-Policy": ("frame-ancestors '"'"'self'"'"' " + $o)}}}}' > "$conf/jupyter_server_config.json"
    export JUPYTER_CONFIG_PATH="$conf"
    # No token: the platform proxy gates access.
    exec ${serverEnv}/bin/jupyter lab \
      --ip 0.0.0.0 --port ${toString cfg.port} --no-browser --allow-root \
      --ServerApp.base_url="$base" \
      --ServerApp.root_dir=/workspace \
      --IdentityProvider.token= --ServerApp.password= \
      --ServerApp.disable_check_xsrf=True \
      --ServerApp.allow_origin='*' \
      --MappingKernelManager.default_kernel_name=python3 \
      --LabApp.app_settings_dir=${labSettings} \
      --collaborative
  '';

  # Printed by scooter-service; mirrors scooter-jupyter.md.
  hint = ''
    Drive notebooks with the mcp__sandbox-jupyter__* tools, never by editing .ipynb files on disk.
    Kernels: "Python (notebook)" takes deps from the notebook's `# /// script` cell; "Python (workspace)" is a shared venv.
  '';
in
{
  environment.systemPackages = lib.mkIf cfg.enable [ pkgs.curl pkgs.jq ];

  webServices.jupyter = {
    enable = lib.mkDefault true;
    port = lib.mkDefault 2719;
    displayName = lib.mkDefault "Jupyter";
    command = lib.mkDefault "${labServer}";
    hint = lib.mkDefault hint;
    # Root, like the agent's shell.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";
    extraConfig = {
      wants = [ "mcp-jupyter.service" ];
      environment = uvEnv // {
        JUPYTER_PATH = "${jupyterData}/share/jupyter";
        # Lab state survives pod rebuilds on the PVC.
        JUPYTER_CONFIG_DIR = "/workspace/.jupyter/config";
        JUPYTER_DATA_DIR = "/workspace/.jupyter/data";
        HOME = "/root";
      };
    };
  };

  mcpServers.jupyter = {
    enable = lib.mkDefault cfg.enable;
    displayName = lib.mkDefault "Jupyter";
    user = lib.mkDefault "root";
    # Useless without lab, so it starts with lab.
    autoStart = lib.mkDefault false;
    command = lib.mkDefault "${pkgs.writeShellScript "mcp-jupyter" ''
      set -euo pipefail
      # Lab's base path, from its unit's environment.
      set -a; . /run/webservice-jupyter/conv.env; set +a
      base=${basePath}
      exec ${pkgs.uv}/bin/uv tool run --from jupyter-mcp-server==${mcpVersion} jupyter-mcp-server start \
        --transport streamable-http --host 0.0.0.0 --port "$MCP_PORT" \
        --jupyter-url "http://127.0.0.1:${toString cfg.port}$base" \
        --start-new-code-sandbox false \
        --insecure-mcp-noauth
    ''}";
    environment = lib.mkDefault uvEnv;
    extraConfig = {
      after = [ "webservice-jupyter.service" ];
      bindsTo = [ "webservice-jupyter.service" ];
      # uvicorn exits 143 on SIGTERM.
      serviceConfig.SuccessExitStatus = [ "143" ];
    };
  };
}
