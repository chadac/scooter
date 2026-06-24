# Render check for the example platform config.
#
# `nix eval -f examples/check.nix` (see `just check-manifests`). Renders
# examples/kubenix-config.nix and asserts every expected resource is present —
# catching (a) Nix syntax / module eval errors and (b) SILENT resource drops
# (e.g. a shallow `//` overwriting `deployments` and losing agent-host, which
# renders a valid-but-wrong manifest set a plain build won't catch).
let
  flake = builtins.getFlake (toString ../.);
  system = builtins.currentSystem;

  platform = flake.inputs.kubenix.evalModules.${system} {
    module = ./kubenix-config.nix;
  };

  res = platform.config.kubernetes.resources;

  # resource-kind -> names the platform MUST render with all features enabled.
  expect = {
    deployments = [ "agent-host" "agent-broker" "agent-webhooks" "ui" ];
    services = [ "agent-host" "agent-broker" "agent-webhooks" "ui" ];
    configMaps = [ "agent-skills" ];
  };

  missingFor = kind: want:
    let have = builtins.attrNames (res.${kind} or { });
    in builtins.filter (n: !(builtins.elem n have)) want;

  problems = builtins.concatLists (builtins.attrValues (builtins.mapAttrs
    (kind: want: map (n: "${kind}.${n}") (missingFor kind want))
    expect));

  haveDeps = builtins.concatStringsSep ", " (builtins.attrNames (res.deployments or { }));
in
if problems == [ ]
then "ok: deployments = ${haveDeps}\n"
else builtins.throw "example manifests missing: ${builtins.concatStringsSep ", " problems}"
