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

  # The datadog provider (enabled in the example) must wire its two-key secret
  # env into the broker deployment — otherwise the provider stays disabled and
  # /datadog/* 404s. Assert DATADOG_API_KEY lands in a broker container's env.
  brokerEnv =
    let ctrs = builtins.attrValues (res.deployments.agent-broker.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  ddWired = builtins.any (e: e.name == "DATADOG_API_KEY") brokerEnv;
  ddProblems = if ddWired then [ ] else [ "broker.env.DATADOG_API_KEY (datadog provider not wired)" ];

  allProblems = problems ++ ddProblems;
in
if allProblems == [ ]
then "ok: deployments = ${haveDeps}; datadog wired\n"
else builtins.throw "example manifests missing: ${builtins.concatStringsSep ", " allProblems}"
