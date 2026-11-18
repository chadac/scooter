# Headless screenshots; Linux only.
{ pkgs }:
pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux { chromium = pkgs.chromium; }
