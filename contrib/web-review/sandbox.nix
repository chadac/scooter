# web-review's sandbox half: "Review" (webServices.review), the chat beside an app the
# user is building, and the proxy in front of that app (webServices.review-app,
# unlisted), which injects the review overlay and runs the notes API under
# /review-app/__review/. Starting Review starts the proxy and the app's unit. Review
# is on once webReview.target is set, which `review target` does through a module in
# /etc/scooter/modules and a rebuild, so the target is fixed at build time.
#
# Supplies mkDefault values only and must not gate on `cfg.enable` (infinite
# recursion); web-services.nix filters on `.enable` when it renders units.

{ config, lib, pkgs, ... }:

let
  shell = config.webServices.review;
  app = config.webServices.review-app;
  review = pkgs.callPackage ./review { };
  stateDir = "/workspace/.scooter/review";
  target = config.webReview.target;
  devUnit = "webservice-review-dev.service";
  # The unit the proxy waits for: the dev server, or the agent's own unit.
  appUnits =
    if target == null then [ ]
    else if target.run != null then [ devUnit ]
    else lib.optional (target.unit != null) target.unit;

  targetFile = pkgs.writeText "review-target.json" (builtins.toJSON (lib.filterAttrs (_: v: v != null) {
    inherit (target) port run cwd unit;
    env = target.environment;
  }));

  # Shared by both units and the CLI.
  env = {
    REVIEW_SHELL_PORT = toString shell.port;
    REVIEW_APP_PORT = toString app.port;
    REVIEW_STATE_DIR = stateDir;
    REVIEW_VENDOR_DIR = "${review.vendor}";
    REVIEW_CHAT_PAGE_DIR = "${config.chatPage.assets}";
  } // lib.optionalAttrs (target != null) {
    REVIEW_TARGET = "${targetFile}";
  } // lib.optionalAttrs (config.webReview.chromium != null) {
    REVIEW_CHROMIUM = "${config.webReview.chromium}/bin/chromium";
  };

  cli = pkgs.writeShellScriptBin "review" ''
    ${lib.concatStrings (lib.mapAttrsToList (k: v: "export ${k}=${lib.escapeShellArg v}\n") env)}
    exec ${review}/bin/review "$@"
  '';

  hint = ''
    The app must serve under $REVIEW_BASE (`review status` prints it): Vite --base, Next basePath, ….
    Answer notes with `review reply <id> "…"` and `review resolve <id>`; `review snap` shows you the user's page.
  '';
in
{
  options.webReview.chromium = lib.mkOption {
    type = lib.types.nullOr lib.types.package;
    # A stub (modules/sandbox-os/stubs.nix): built on the first headless screenshot.
    default = pkgs.chromium;
    defaultText = lib.literalExpression "pkgs.chromium";
    description = "The browser for headless screenshots when no review page is open; null disables them.";
  };

  options.webReview.target = lib.mkOption {
    type = lib.types.nullOr (lib.types.submodule {
      options = {
        port = lib.mkOption {
          type = lib.types.port;
          description = "The port the app's dev server listens on, serving under $REVIEW_BASE.";
        };
        run = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "A shell command run as webservice-review-dev, started with Review; it gets PORT, REVIEW_BASE and REVIEW_PUBLIC_URL.";
        };
        cwd = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "The app's source directory: `run`'s working directory, and named in notes.";
        };
        unit = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "A systemd unit that serves the app on `port`, started with Review. Not with `run`.";
        };
        environment = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
          description = "Extra environment for `run`; `review target` records the caller's PATH here.";
        };
      };
    });
    default = null;
    description = "The app under review. Setting it turns Review on; `review target` writes it.";
  };

  # Installed while Review is off: `review target` turns it on.
  config.environment.systemPackages = [ cli ];

  config.assertions = lib.optional (target != null) {
    assertion = target.run == null || target.unit == null;
    message = "webReview.target: set run or unit, not both";
  };

  config.systemd.services.webservice-review-dev = lib.mkIf (shell.enable && target != null && target.run != null) {
    description = "Review: the app's dev server";
    partOf = [ "webservice-review.service" ];
    # target.environment (the caller's PATH) is applied by `scooter-review dev`.
    environment = env;
    path = [ "/run/current-system/sw" "/run/wrappers" ];
    serviceConfig = {
      ExecStart = "${review}/bin/scooter-review dev";
      WorkingDirectory = lib.mkIf (target.cwd != null) target.cwd;
      KillMode = "mixed";
      Restart = "on-failure";
      RestartSec = 2;
    };
  };

  config.webServices.review = {
    enable = lib.mkDefault (target != null);
    port = lib.mkDefault 2731;
    displayName = lib.mkDefault "Review";
    hint = lib.mkDefault hint;
    environment = lib.mkDefault env;
    command = lib.mkDefault "${review}/bin/scooter-review shell";
    extraConfig.wants = [ "webservice-review-app.service" ];
  };

  config.webServices.review-app = {
    enable = lib.mkDefault shell.enable;
    port = lib.mkDefault 2732;
    displayName = lib.mkDefault "Review app";
    visibleInMenu = lib.mkDefault false;
    workingDirectory = lib.mkDefault "/workspace";
    environment = lib.mkDefault env;
    command = lib.mkDefault "${review}/bin/scooter-review proxy";
    extraConfig = {
      partOf = [ "webservice-review.service" ];
      wants = appUnits;
      after = appUnits;
    };
  };
}
