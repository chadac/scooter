# webServices.<name>.chatPage: a static "<app> + chat" page.

{ config, lib, pkgs, ... }:

let
  head = "<style>\n${builtins.readFile ./chat-page/chat-page.css}</style>\n"
    + "<script>\n${builtins.readFile ./chat-page/chat-page.js}</script>";

  server = name: s:
    let
      c = s.chatPage;
      # The start script adds chatUrl and convUrl.
      staticConfig = pkgs.writeText "${name}-chat-page.json" (builtins.toJSON {
        inherit (c) app storageKey;
        full = { href = c.app; title = c.fullTitle; target = "_top"; };
      });
      page = pkgs.writeText "${name}-chat-page.html" (builtins.replaceStrings
        [ "@TITLE@" "@CHAT_PAGE@" "@EXTRA_SCRIPT@" ]
        [
          (lib.escapeXML c.title)
          head
          (lib.optionalString (c.extraScript != null) "<script>\n${builtins.readFile c.extraScript}</script>")
        ]
        (builtins.readFile ./chat-page/index.html));
    in
    pkgs.writeShellScript "${name}-chat-page" ''
      set -euo pipefail
      www="''${RUNTIME_DIRECTORY%%:*}/www"
      mkdir -p "$www"
      conv="''${CONVERSATION_URL:-}"
      # SCOOTER_CHAT_URL overrides the derived /chat/<id>.
      chat="''${SCOOTER_CHAT_URL:-}"
      if [ -z "$chat" ] && [ -n "$conv" ] && [ -n "''${CONVERSATION_ID:-}" ]; then
        chat="$(printf %s "$conv" | sed -n 's|^\(https\{0,1\}://[^/]*\).*|\1|p')/chat/$CONVERSATION_ID"
      fi
      # Escaped < keeps the JSON inside its <script>.
      cfg="$(${pkgs.jq}/bin/jq -c --arg chat "$chat" --arg conv "$conv" '. + {chatUrl: $chat, convUrl: $conv}' ${staticConfig} \
        | sed 's/</\\u003c/g')"
      esc() { printf %s "$1" | sed 's/[&|\\]/\\&/g'; }
      sed "s|@CONFIG@|$(esc "$cfg")|" ${page} > "$www/index.html"
      exec ${pkgs.darkhttpd}/bin/darkhttpd "$www" --addr 0.0.0.0 --port ${toString s.port} --no-listing --no-server-id
    '';

  serviceOpts = { name, config, ... }: {
    options.chatPage = lib.mkOption {
      type = lib.types.nullOr (lib.types.submodule {
        options = {
          app = lib.mkOption {
            type = lib.types.str;
            example = "../marimo/";
            description = ''
              The app beside the chat, as a URL relative to this page, usually an unlisted
              service: `../<service>/`. The page's query and hash are passed on to it.
            '';
          };
          title = lib.mkOption {
            type = lib.types.str;
            default = config.displayName;
            defaultText = lib.literalExpression "displayName";
            description = "The page's title.";
          };
          fullTitle = lib.mkOption {
            type = lib.types.str;
            default = "${config.chatPage.title} full screen";
            defaultText = lib.literalExpression ''"''${title} full screen"'';
            description = "The tooltip of the rail's link to the app on its own.";
          };
          storageKey = lib.mkOption {
            type = lib.types.str;
            default = name;
            description = "Keeps the chat's width and collapsed state in localStorage as scooter.<storageKey>.*.";
          };
          extraScript = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = ''
              JS run after the page mounts, for app-specific behaviour (marimo's keeps its
              route in the address bar). It sees the globals `CFG`, `APP` (the app's URL),
              `page` (`{ layout, chat, rail, full }`) and `frame` (the app's iframe).
            '';
          };
        };
      });
      default = null;
      example = lib.literalExpression ''{ app = "../jupyter/"; }'';
      description = ''
        Makes this service "<app> + chat": the conversation beside `app`, with a
        resizable, collapsible chat pane. Sets `command` and `stripBasePath`; start the
        framed service with it through `extraConfig.wants`.
      '';
    };

    config = lib.mkIf (config.chatPage != null) {
      stripBasePath = lib.mkDefault true;
      command = lib.mkDefault "${server name config}";
    };
  };
in
{
  options.webServices = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule serviceOpts);
  };

  options.chatPage.assets = lib.mkOption {
    type = lib.types.path;
    default = ./chat-page;
    readOnly = true;
    internal = true;
    description = "chat-page.js and chat-page.css, for a chat page served by its own server.";
  };
}
