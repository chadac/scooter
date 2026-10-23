# Generates the UI image's built-in contrib manifest: ui-manifest-data.nix over the
# build's own contrib list, as one JSON document nginx serves at
# /contrib/manifest.json when the deployment mounts none (modules/platform.nix
# mounts the deployment's own, so its disabled contribs show no tab or card). The
# UI fetches it at runtime, so the contrib set changes without recompiling the bundle.
{ lib, writeText }:

let
  mkData = import ./ui-manifest-data.nix { inherit lib; };
in
contribs:

let
  data = mkData contribs;
in
# `data` rides along so an eval (examples/check.nix) can read the manifest without a build.
writeText "contrib-manifest.json" (builtins.toJSON data) // { inherit data; }
