# The enabled contribs' APPROVAL declarations, derived from this source tree alone.
#
# One declaration (contrib/<name>/default.nix `approvals`) feeds two consumers that
# must agree or the feature is worse than absent:
#
#   host  — where to relay the human's answer (APPROVAL_CONTRIBS_JSON, modules/platform.nix)
#   ui    — which option to grey for a viewer who may not use it (the contrib manifest)
#
# They are rendered from the SAME attrset here rather than declared twice, because the
# failure mode of disagreement is silent and bad: the UI tells a user they may approve
# and the relay then authorizes someone else, or the UI greys a button the broker would
# have accepted. That exact split — a per-viewer check and a relay authorizing different
# principals — is the bug PR #649 fixed, and deriving both ends from one source is what
# stops it recurring by configuration.
#
# `lib`-only, like contrib/sandbox-modules.nix (#607) and contrib/skills.nix (#618):
# the consumers are kubenix modules an external deployer imports with no `pkgs`.
{ lib, extraModules ? [ ] }:

let
  eval = lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };

  # A disabled contrib contributes nothing — `enable = false` means absent, with no
  # `mkIf` in any contrib's declaration.
  enabled = lib.filterAttrs (_: c: c.enable && c.approvals != null) eval.config.contribs;
in
{
  # name -> { brokerPrefix, pendingPath }. What the AGENT-HOST needs: how to reach the
  # verbs. Deliberately not the UI copy — the host has no business carrying prose.
  host = lib.mapAttrs
    (_: c: {
      inherit (c.approvals) brokerPrefix;
      pendingPath = c.approvals.pendingPath;
    })
    enabled;

  # name -> { gatedOption, blockedTitle, blockedHint }. What the UI needs: which option
  # to grey and what to say. Deliberately not brokerPrefix — a browser must never learn
  # a broker path it could be pointed at.
  ui = lib.mapAttrs
    (_: c: {
      inherit (c.approvals) gatedOption blockedTitle blockedHint;
    })
    enabled;
}
