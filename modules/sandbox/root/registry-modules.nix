# Fetch + import a conversation's ATTACHED registry modules from the broker.
#
# The agent attaches shared modules from the registry (`scooter-rebuild module add
# <id>` — a #133 follow-up records the id). This module — always part of the sandbox-os
# config, so it participates in EVERY re-converge — reads the attached-id list, fetches
# those modules from the broker as ONE gzipped tarball, and imports them.
#
# The broker's registry download endpoint (GET /modules.tar.gz?ids=a,b) returns a tar
# of <id>/module.nix (+ optional siblings); this imports each <id>/module.nix.
#
# The attached ids live in /etc/scooter/registry-modules.json — a JSON LIST of ids
# (["a","b"]) that scooter-rebuild manages. HARDCODED path (scooter-rebuild owns
# /etc/scooter). Mirrors broker-modules.nix (deployment defaults) + local-modules.nix
# (the agent's own): this is the SHARED-registry half.
#
# IMPURE: reads the id list + fetches a runtime URL during the in-pod `nix build
# --impure`. FAIL-SAFE: no id list / empty / no BROKER_URL -> imports NOTHING. A
# PRESENT-but-corrupt id list is NOT swallowed (fromJSON aborts the switch — surfaced).
# A broken attached module fails the scooter-apply-module build gate.

{ lib, ... }:

let
  # The attached-ids file. SCOOTER_REGISTRY_IDS_FILE is a TEST-ONLY override; prod is
  # hardcoded (scooter-rebuild owns /etc/scooter).
  idsFileOverride = builtins.getEnv "SCOOTER_REGISTRY_IDS_FILE";
  idsFile = if idsFileOverride != "" then idsFileOverride else "/etc/scooter/registry-modules.json";

  # The attached ids (a JSON list). Absent -> none. Corrupt -> fromJSON throws (hard-fail).
  ids =
    if builtins.pathExists idsFile
    then builtins.fromJSON (builtins.readFile idsFile)
    else [ ];

  # The broker base URL the pod fetches from. SCOOTER_REGISTRY_URL overrides the whole
  # URL (tests point it at a file:// fixture); else derive from BROKER_URL + the ids.
  brokerUrl = builtins.getEnv "BROKER_URL";
  urlOverride = builtins.getEnv "SCOOTER_REGISTRY_URL";
  tarballUrl =
    if urlOverride != "" then urlOverride
    else if brokerUrl != "" then "${brokerUrl}/modules.tar.gz?ids=${lib.concatStringsSep "," ids}"
    else "";

  # Fetch the attached modules as ONE gzipped tarball (<id>/module.nix + siblings).
  # Skipped when nothing is attached or no source is configured.
  fetched =
    if tarballUrl != "" && ids != [ ]
    then builtins.fetchTarball { url = tarballUrl; }
    else null;

  # Each attached id -> its module.nix in the fetched tree. `fetched` is a store path
  # (from fetchTarball), so a plain string "${fetched}/<id>/module.nix" is a store-path
  # ref the module system imports directly (NOT `/. +`, which rejects a store-path string).
  modulePaths =
    if fetched == null then [ ]
    else map (id: "${fetched}/${id}/module.nix") ids;
in
{
  imports = modulePaths;
}
