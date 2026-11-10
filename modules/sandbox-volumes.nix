# The per-conversation sandbox's PVCs, typed with kubenix's generated k8s definitions and
# rendered for the agent-host provisioner (SANDBOX_VOLUME_CLAIMS), which builds the claims.

{ config, lib, ... }:

let
  inherit (lib) mkOption mkDefault types;
  cfg = config.scooter;
  defs = config.kubernetes.api.definitions;
  ws = cfg.warmStore;

  claimModule = description: {
    options = {
      # Only what a claim template can carry; Scooter sets the name.
      metadata = {
        labels = mkOption { type = types.attrsOf types.str; default = { }; description = "Labels on the claim."; };
        annotations = mkOption { type = types.attrsOf types.str; default = { }; description = "Annotations on the claim."; };
      };
      spec = mkOption {
        type = types.submodule defs."io.k8s.api.core.v1.PersistentVolumeClaimSpec";
        default = { };
        inherit description;
      };
    };
  };
  claimType = description: types.submodule (claimModule description);

  # expand_workspace limits; the overlay stays fixed for the warm pool.
  workspaceGrowth = {
    options.maxStorage = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "200Gi";
      description = ''
        How far the agent may grow its /workspace claim with `expand_workspace`, which resizes
        the live volume without a restart. `null` leaves the tool off. The claim's
        StorageClass must set `allowVolumeExpansion: true`, or Kubernetes refuses the resize.
      '';
    };
    options.autoMaxStorage = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "50Gi";
      description = ''
        How far the agent may grow /workspace without asking; above it, up to `maxStorage`,
        the owner approves each request on a card. `null` means `maxStorage`.
      '';
    };
  };

  # Drop kubenix's unset (null) fields so the provisioner sees only what was set.
  dropNulls = v:
    if lib.isAttrs v then lib.mapAttrs (_: dropNulls) (lib.filterAttrs (_: x: x != null) v)
    else if lib.isList v then map dropNulls v
    else v;

  render = name: claim: dropNulls {
    metadata = lib.filterAttrs (_: v: v != { }) claim.metadata // { inherit name; };
    inherit (claim) spec;
  };

  overlay = cfg.sandbox.volumes.overlay.spec;
  # Pool PVs only bind a claim of the same class and size.
  poolMismatch = lib.optionals ws.enable (
    lib.optional (overlay.storageClassName != ws.storageClass)
      "storageClassName ${toString overlay.storageClassName} != warmStore.storageClass ${ws.storageClass}"
    ++ lib.optional ((overlay.resources.requests or { }).storage or null != ws.storage)
      "size ${toString ((overlay.resources.requests or { }).storage or null)} != warmStore.storage ${ws.storage}");
in
{
  imports = [
    (lib.mkRenamedOptionModule [ "scooter" "workspaceStorageClass" ]
      [ "scooter" "sandbox" "volumes" "workspace" "spec" "storageClassName" ])
  ];

  options.scooter.sandbox.volumes = {
    workspace = mkOption {
      type = types.submodule [ (claimModule ''
        Spec of the claim mounted at /workspace. Set `storageClassName` when the
        cluster default can't attach to sandbox nodes.
      '') workspaceGrowth ];
      default = { };
      example = { spec.storageClassName = "gp3-crun"; spec.resources.requests.storage = "50Gi"; };
      description = ''
        The /workspace PVC of each conversation's sandbox, as a k8s PersistentVolumeClaim
        `metadata` + `spec`. Changes apply to new conversations only: an existing claim
        keeps its class and size.
      '';
    };
    overlay = mkOption {
      type = claimType ''
        Spec of the Nix overlay-store upper claim. With the warm store on, its class and
        size default to the pool's, and a mismatch fails the render.
      '';
      default = { };
      example = { spec.storageClassName = "gp3-crun"; };
      description = ''
        The /nix/.scooter-rw PVC holding each sandbox's runtime Nix builds, as a k8s
        PersistentVolumeClaim `metadata` + `spec`. Changes apply to new conversations only.
      '';
    };
  };

  options.scooter.sandbox.renderedVolumeClaims = mkOption {
    type = types.attrsOf types.anything;
    readOnly = true;
    internal = true;
    description = "The claims as the provisioner reads them, keyed by claim name.";
  };

  config.scooter.sandbox = {
    volumes.workspace.spec = {
      accessModes = mkDefault [ "ReadWriteOnce" ];
      resources.requests.storage = mkDefault "10Gi";
    };
    volumes.overlay.spec = {
      accessModes = mkDefault [ "ReadWriteOnce" ];
      resources.requests.storage = mkDefault (if ws.enable then ws.storage else "20Gi");
      storageClassName = lib.mkIf ws.enable (mkDefault ws.storageClass);
    };
    renderedVolumeClaims =
      if poolMismatch != [ ] then
        throw "scooter.sandbox.volumes.overlay must match the warm-store pool: ${lib.concatStringsSep "; " poolMismatch}"
      else {
        workspace = render "workspace" cfg.sandbox.volumes.workspace;
        scooter-rw = render "scooter-rw" cfg.sandbox.volumes.overlay;
      };
  };
}
