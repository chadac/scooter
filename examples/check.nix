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
    # deploy-config-files: the deployTools.configFiles ConfigMap (enabled below).
    configMaps = [ "agent-skills" "deploy-config-files" ];
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

  # deployTools.configFiles (enabled in the example) must (a) render the
  # deploy-config-files ConfigMap with the file, and (b) tell the agent-host to
  # mount it via SCOOTER_CONFIG_FILES_CONFIGMAP — else sandboxes never get the files.
  hostEnv =
    let ctrs = builtins.attrValues (res.deployments.agent-host.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  cfWired = builtins.any (e: e.name == "SCOOTER_CONFIG_FILES_CONFIGMAP") hostEnv;
  cfHasFile = (res.configMaps.deploy-config-files.data or { }) ? "nix.conf";
  cfProblems =
    (if cfWired then [ ] else [ "host.env.SCOOTER_CONFIG_FILES_CONFIGMAP (configFiles not wired)" ])
    ++ (if cfHasFile then [ ] else [ "configMaps.deploy-config-files.data.nix.conf (file missing)" ]);

  # broker.aws (enabled in the example) must stamp a checksum/aws-accounts annotation
  # on the broker pod template, so editing an account rolls the pod (a ConfigMap
  # content change alone doesn't trigger a rollout). Assert the annotation is present.
  brokerAnno = res.deployments.agent-broker.spec.template.metadata.annotations or { };
  awsChecksumWired = brokerAnno ? "checksum/aws-accounts";
  csProblems = if awsChecksumWired then [ ]
    else [ "broker.template.annotations.checksum/aws-accounts (config-rollout annotation missing)" ];

  # Shared Postgres probe timeout: the k8s DEFAULT pg_isready probe timeout (1s) once
  # killed the DB in a restart loop (pg_isready couldn't answer in 1s under load),
  # cascading to the broker + every conversation. Render the DB (postgres is gated
  # off in the base example) and assert both probes carry a GENEROUS timeout so this
  # can't silently regress.
  dbPlatform = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.webhooks.postgres = {
        enable = lib.mkForce true;
        passwordSecret = { name = "db"; key = "password"; };
      };
    };
  };
  dbCtr = dbPlatform.config.kubernetes.resources.deployments.agent-shared-db.spec.template.spec.containers.postgres;
  dbTimeoutOk = (dbCtr.livenessProbe.timeoutSeconds or 1) >= 3 && (dbCtr.readinessProbe.timeoutSeconds or 1) >= 3;
  dbProblems = if dbTimeoutOk then [ ]
    else [ "postgres probe timeoutSeconds too tight (< 3s) — the 1s default caused a restart-loop outage" ];

  allProblems = problems ++ ddProblems ++ cfProblems ++ csProblems ++ dbProblems;
in
if allProblems == [ ]
then "ok: deployments = ${haveDeps}; datadog wired; configFiles wired; broker config-rollout wired\n"
else builtins.throw "example manifests missing: ${builtins.concatStringsSep ", " allProblems}"
