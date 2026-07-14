# Fetch + import the DEPLOYMENT'S DEFAULT NixOS modules from the broker.
#
# Every sandbox pod, at re-converge time, pulls the deployment's baseline module
# config from the broker as ONE gzipped tarball and imports the modules it contains.
# The tarball is `<name>.nix` files at its root (the deployment's defaults, served by
# the broker at GET /modules/default.tar.gz — unauthenticated, module Nix isn't a
# secret). This is the replacement for the deleted per-conversation module ConfigMap.
#
# IMPURE by nature: it reads BROKER_URL and fetches a runtime URL during the in-pod
# `nix build --impure` (the same impurity the runtime re-converge already relies on).
#
# FAIL-SAFE: no BROKER_URL (and no override) -> imports NOTHING (the pod boots on the
# baseline sandbox-os config; a missing broker never breaks the build/boot). An empty
# default set on the broker likewise yields an empty tarball -> no imports.
#
# Mirrors registry-modules.nix (a later PR adds the per-conversation registry path);
# this module is the deployment-DEFAULTS half.

{ lib, ... }:

let
  # The broker base URL the pod fetches from. Baked at image build via the env (same
  # source the broker CLIs read); empty -> no fetch (no modules).
  brokerUrl = builtins.getEnv "BROKER_URL";

  # The tarball URL. Derived from BROKER_URL; SCOOTER_DEFAULT_MODULES_URL overrides it
  # verbatim (tests point it at a file:// fixture). Impure eval makes the runtime read
  # fine.
  urlOverride = builtins.getEnv "SCOOTER_DEFAULT_MODULES_URL";
  tarballUrl =
    if urlOverride != "" then urlOverride
    else if brokerUrl != "" then "${brokerUrl}/modules/default.tar.gz"
    else "";

  # Fetch the default modules as ONE gzipped tarball. Skipped when no source is
  # configured (no BROKER_URL and no override) -> nothing imported.
  fetched =
    if tarballUrl != ""
    then builtins.fetchTarball { url = tarballUrl; }
    else null;

  # Every `.nix` file at the tarball root is a default module to import. A tarball
  # with no `.nix` files (empty default set) -> no imports.
  modulePaths =
    if fetched == null then [ ]
    else
      let
        entries = builtins.readDir fetched;
        isNix = name: type: type == "regular" && lib.hasSuffix ".nix" name;
        names = builtins.filter (n: isNix n entries.${n}) (builtins.attrNames entries);
      in
      map (n: "${fetched}/${n}") names;
in
{
  imports = modulePaths;
}
