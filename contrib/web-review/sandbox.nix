# web-review's sandbox half: "Review" (webServices.review), the chat beside an app the
# user is building, and the proxy in front of that app (webServices.review-app,
# unlisted), which injects the review overlay and runs the notes API under
# /review-app/__review/. Starting Review starts the proxy. Review is off until the
# agent has run `review target` and set webServices.review.enable.
#
# Supplies mkDefault values only and must not gate on `cfg.enable` (infinite
# recursion); web-services.nix filters on `.enable` when it renders units.

{ config, lib, pkgs, ... }:

let
  shell = config.webServices.review;
  app = config.webServices.review-app;
  review = pkgs.callPackage ./review { };
  stateDir = "/workspace/.scooter/review";

  # Shared by both units and the CLI.
  env = {
    REVIEW_SHELL_PORT = toString shell.port;
    REVIEW_APP_PORT = toString app.port;
    REVIEW_STATE_DIR = stateDir;
    REVIEW_VENDOR_DIR = "${review.vendor}";
  } // lib.optionalAttrs (config.webReview.chromium != null) {
    REVIEW_CHROMIUM = "${config.webReview.chromium}/bin/chromium";
  };

  cli = pkgs.writeShellScriptBin "review" ''
    ${lib.concatStrings (lib.mapAttrsToList (k: v: "export ${k}=${lib.escapeShellArg v}\n") env)}
    export REVIEW_ENABLED=${if shell.enable then "1" else "0"}
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

  # Installed while Review is off, so the agent can configure it first.
  config.environment.systemPackages = [ cli ];

  config.webServices.review = {
    enable = lib.mkDefault false;
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
    # Root: writes the workspace PVC and runs systemd-run.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";
    environment = lib.mkDefault env;
    command = lib.mkDefault "${review}/bin/scooter-review proxy";
    extraConfig.partOf = [ "webservice-review.service" ];
  };
}
