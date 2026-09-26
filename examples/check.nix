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
    # agent-host is a Deployment (random pods; routing by pod IP + surge rollout).
    # warm-store-controller is enabled in the example → its Deployment must render.
    # byoc-controller renders from the ONE-KNOB enable (byoc.enable = true, nothing else) —
    # pinning that the ingress/remote-agent/bridge-URL derivation actually composes.
    deployments = [ "agent-host" "agent-broker" "agent-webhooks" "ui" "warm-store-controller" "byoc-controller" ];
    services = [ "agent-host" "agent-host-pods" "agent-broker" "agent-webhooks" "ui" ];
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

  # Same for airtable (enabled in the example): without AIRTABLE_TOKEN in the
  # broker env the provider stays disabled and /airtable/* 404s.
  atProblems = if builtins.any (e: e.name == "AIRTABLE_TOKEN") brokerEnv then [ ]
    else [ "broker.env.AIRTABLE_TOKEN (airtable provider not wired)" ];

  # Static shares (shares.enable = true in the example): the broker must carry
  # SHARES_ENABLED and a derived public base URL — otherwise the /shares +
  # /s/<uuid>/ routes never mount (or return relative URLs) and publishing 404s.
  sharesEnvVal = name: let m = builtins.filter (e: e.name == name) brokerEnv; in if m == [ ] then "" else (builtins.head m).value;
  sharesProblems =
    (if builtins.any (e: e.name == "SHARES_ENABLED") brokerEnv then [ ]
     else [ "broker.env.SHARES_ENABLED (shares.enable = true not wired)" ])
    ++ (if builtins.match "https://.+" (sharesEnvVal "SHARES_PUBLIC_BASE_URL") != null then [ ]
        else [ "broker.env.SHARES_PUBLIC_BASE_URL (should derive from ingress.host)" ]);

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

  # A sandbox can reach the broker over the network and cannot reach the agent-host, so
  # sandbox-shaping config must stay off the broker. Why: PR #584.
  sandboxShapingEnv = [
    "SANDBOX_IMAGE" "SANDBOX_PULL_POLICY" "SANDBOX_RUNTIME_CLASS" "SANDBOX_RESOURCES"
    "SANDBOX_SIZES_JSON" "SANDBOX_MANIFEST_OVERLAY_CONFIGMAP"
    "SCOOTER_CONFIGMAP" "SCOOTER_CONFIG_FILES_CONFIGMAP" "SCOOTER_TOKEN_AUDIENCES" "SCOOTER_ENV"
  ];
  oneEntrypointProblems =
    map (n: "broker.env.${n} — sandbox-shaping env belongs to the agent-host")
      (builtins.filter (n: builtins.any (e: e.name == n) brokerEnv) sandboxShapingEnv)
    ++ (if (res.roles or { }) ? agent-broker-sandbox
        then [ "roles.agent-broker-sandbox — the broker must not hold Sandbox/SA/PVC RBAC" ] else [ ])
    ++ (if builtins.any (e: e.name == "SANDBOX_PULL_POLICY") hostEnv then [ ]
        else [ "host.env.SANDBOX_PULL_POLICY (a side-loaded cluster ImagePullBackOffs every sandbox)" ])
    ++ (if builtins.any (e: e.name == "SANDBOX_SIZES_JSON") hostEnv then [ ]
        else [ "host.env.SANDBOX_SIZES_JSON (the size picker and the agent's resize tools see no presets)" ]);

  # Rollout-drain topology invariants (todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md) — the fields a
  # seamless rollout depends on. A regression here (reverting to a StatefulSet, dropping the
  # surge strategy, re-adding a per-pod PVC, or losing the routing IP field) silently
  # reintroduces the capacity gap / breaks routing, so pin them at render time.
  ahDep = res.deployments.agent-host.spec or { };
  ahStrategy = ahDep.strategy or { };
  ahRolling = ahStrategy.rollingUpdate or { };
  stateVol = builtins.head (builtins.filter (v: v.name == "state")
    (res.deployments.agent-host.spec.template.spec.volumes or [ ]) ++ [ { } ]);
  crdVersions = res.customResourceDefinitions.conversations.spec.versions or [ ];
  crdStatusProps =
    if crdVersions == [ ] then { }
    else (builtins.head crdVersions).schema.openAPIV3Schema.properties.status.properties or { };
  rolloutProblems =
    (if (ahStrategy.type or "") == "RollingUpdate" then [ ] else [ "agent-host.strategy.type != RollingUpdate (needs surge, not Recreate/STS)" ])
    ++ (if (ahRolling.maxUnavailable or null) == 0 then [ ] else [ "agent-host.strategy.maxUnavailable != 0 (a rollout would drop capacity)" ])
    ++ (if (ahRolling.maxSurge or null) == 1 then [ ] else [ "agent-host.strategy.maxSurge != 1 (no new-pod-before-old-drains)" ])
    ++ (if (stateVol ? emptyDir) then [ ] else [ "agent-host `state` volume is not an emptyDir (a per-pod PVC blocks surge via Multi-Attach)" ])
    ++ (if (crdStatusProps ? hostIP) then [ ] else [ "Conversation CRD status.hostIP missing (the router's routing address)" ]);

  # The model catalog (agent.availableModels attrset) must render AGENT_MODELS_JSON
  # (rich: ids + hints + default) into the agent-host env, and GOOSE_MODEL as the
  # derived default. NOTE: the example sets fakeAgent, which gates these off — so
  # render a NON-fake platform to force the model-env derivation + assert it.
  modelPlatform = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.fakeAgent = lib.mkForce false;
    };
  };
  mHostEnv =
    let ctrs = builtins.attrValues (modelPlatform.config.kubernetes.resources.deployments.agent-host.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  mEnvVal = name: let m = builtins.filter (e: e.name == name) mHostEnv; in if m == [ ] then "" else (builtins.head m).value;
  modelsJson = mEnvVal "AGENT_MODELS_JSON";
  gooseModel = mEnvVal "GOOSE_MODEL";
  parsedModels = if modelsJson == "" then [ ] else builtins.fromJSON modelsJson;
  sonnetEntry = builtins.filter (m: m.id == "us.anthropic.claude-sonnet-4-6") parsedModels;
  mdProblems =
    (if parsedModels != [ ] then [ ] else [ "host.env.AGENT_MODELS_JSON (model catalog not rendered)" ])
    ++ (if gooseModel == "us.anthropic.claude-sonnet-4-6" then [ ]
        else [ "GOOSE_MODEL should be the default (sonnet), got '${gooseModel}'" ])
    ++ (if sonnetEntry != [ ] && (builtins.head sonnetEntry).default && (builtins.head sonnetEntry).hint != "" then [ ]
        else [ "AGENT_MODELS_JSON: sonnet should be default:true with a hint" ]);

  # NO-GOOSE FALLBACK (regression: platform.nix defaultModelId). A subscription-/BYOC-only
  # deployment has no `goose` provider group, so the global default must fall through to a
  # provider's EXPLICIT `default` — NOT lib.head of the alphabetically-sorted model ids.
  # Here every provider marks `claude-opus-5` default while `claude-fable-5` sorts ahead of it:
  # a correct render picks the chosen opus; the pre-fix bug picked fable on sort order alone
  # (and fable was the priciest model). The alphabetically-earlier id is what makes this test
  # fail for the RIGHT reason if the fallback regresses. Render a non-fake, no-goose platform.
  noGoosePlatform = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.fakeAgent = lib.mkForce false;
      agentSandbox.agent.availableModels = lib.mkForce {
        "claude-code"."claude-opus-5" = { default = true; };
        "claude-code"."claude-fable-5" = { };
        byoc."claude-opus-5" = { default = true; };
        byoc."claude-fable-5" = { };
      };
    };
  };
  ngHostEnv =
    let ctrs = builtins.attrValues (noGoosePlatform.config.kubernetes.resources.deployments.agent-host.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  ngEnvVal = name: let m = builtins.filter (e: e.name == name) ngHostEnv; in if m == [ ] then "" else (builtins.head m).value;
  ngGooseModel = ngEnvVal "GOOSE_MODEL";
  ngModels = let j = ngEnvVal "AGENT_MODELS_JSON"; in if j == "" then [ ] else builtins.fromJSON j;
  ngOpus = builtins.filter (m: m.id == "claude-opus-5") ngModels;
  ngProblems =
    (if ngGooseModel == "claude-opus-5" then [ ]
     else [ "no-goose: GOOSE_MODEL should fall through to the per-provider default (claude-opus-5), got '${ngGooseModel}'" ])
    ++ (if ngOpus != [ ] && (builtins.head ngOpus).default then [ ]
        else [ "no-goose: AGENT_MODELS_JSON claude-opus-5 should be default:true" ]);

  # broker.aws (enabled in the example) must stamp a checksum/aws-accounts annotation
  # on the broker pod template, so editing an account rolls the pod (a ConfigMap
  # content change alone doesn't trigger a rollout). Assert the annotation is present.
  brokerAnno = res.deployments.agent-broker.spec.template.metadata.annotations or { };
  awsChecksumWired = brokerAnno ? "checksum/aws-accounts";
  csProblems = if awsChecksumWired then [ ]
    else [ "broker.template.annotations.checksum/aws-accounts (config-rollout annotation missing)" ];

  # Shared Postgres probe timeout: the k8s DEFAULT pg_isready probe timeout (1s) once
  # killed the DB in a restart loop (pg_isready couldn't answer in 1s under load),
  # cascading to the broker + every conversation. Postgres is ALWAYS on now
  # (agentSandbox.postgres), so agent-shared-db renders in the base platform — assert
  # both probes carry a GENEROUS timeout so this can't silently regress.
  dbCtr = platform.config.kubernetes.resources.deployments.agent-shared-db.spec.template.spec.containers.postgres;
  dbTimeoutOk = (dbCtr.livenessProbe.timeoutSeconds or 1) >= 3 && (dbCtr.readinessProbe.timeoutSeconds or 1) >= 3;
  dbProblems = if dbTimeoutOk then [ ]
    else [ "postgres probe timeoutSeconds too tight (< 3s) — the 1s default caused a restart-loop outage" ];

  # publicUrl decoupled from ingress.enable: when the chat ingress is DISABLED but a
  # host IS set (the aeonai case — an oauth2-proxy reverse-proxy fronts the host, so
  # scooter must not render a competing Ingress), PUBLIC_URL (agent-host) and
  # AGENT_MANAGER_URL (webhooks) must STILL populate from the host — else the
  # "View conversation" deep-links degrade to a raw conversation id. Render a second
  # platform with ingress disabled and assert the URLs are set AND no chat Ingress
  # was rendered.
  ingressOffPlatform = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.ingress.enable = lib.mkForce false;
    };
  };
  ioRes = ingressOffPlatform.config.kubernetes.resources;
  envVal = dep: name:
    let
      # agent-host is a StatefulSet, the rest Deployments — look in both.
      workload = ioRes.deployments.${dep} or ioRes.statefulSets.${dep} or null;
      ctrs = builtins.attrValues (workload.spec.template.spec.containers or { });
      env = builtins.concatMap (c: c.env or [ ]) ctrs;
      m = builtins.filter (e: e.name == name) env;
    in if m == [ ] then "" else (builtins.head m).value;
  publicUrlSet = builtins.match "https://.+" (envVal "agent-host" "PUBLIC_URL") != null;
  managerUrlSet = builtins.match "https://.+" (envVal "agent-webhooks" "AGENT_MANAGER_URL") != null;
  # And crucially it must NOT render a competing chat Ingress when disabled.
  noChatIngress = !(ioRes.ingresses.agent-host or null != null);
  puProblems =
    (if publicUrlSet then [ ] else [ "ingress-disabled: PUBLIC_URL empty (should derive from host)" ])
    ++ (if managerUrlSet then [ ] else [ "ingress-disabled: AGENT_MANAGER_URL empty (should derive from host)" ])
    ++ (if noChatIngress then [ ] else [ "ingress-disabled: a chat Ingress was rendered anyway (competing router)" ]);

  # TEST-ONLY ISOLATION (modules/testing.nix). A production render must NEVER carry test
  # affordances. These used to be booleans on the production modules, so `fakeAgent = true` in a
  # deploy config would have silently swapped the real agent for a dummy that answers every prompt
  # with canned text — and nothing would have objected. They now live in a module a deploy never
  # imports, and this asserts the separation actually holds in the RENDERED manifest rather than
  # trusting the option plumbing.
  prodPlatform = flake.inputs.kubenix.evalModules.${system} {
    module = { ... }: { imports = [ ./kubenix-config.nix ]; };
  };
  prodRes = prodPlatform.config.kubernetes.resources;
  prodHostEnv =
    let ctrs = builtins.attrValues (prodRes.deployments.agent-host.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  hasEnv = name: builtins.any (e: e.name == name) prodHostEnv;
  # The example config sets fakeAgent directly (it predates the module); what matters here is that
  # the TESTING MODULE's own artifacts never appear without importing it.
  testProblems =
    (if !(prodRes.configMaps ? agent-testing-marker) then [ ]
     else [ "production render carries the agent-testing-marker ConfigMap (testing.nix leaked in)" ])
    ++ (if !(prodPlatform.options.agentSandbox ? testing) then [ ]
        else [ "agentSandbox.testing option exists WITHOUT importing modules/testing.nix (a deploy could set it)" ]);

  # The SCHEDULER (enabled in the example) must render its Deployment and carry the relay key
  # + tick — a scheduled run is otherwise silently never delivered.
  schedEnv =
    let ctrs = builtins.attrValues (res.deployments.agent-scheduler.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  schedProblems =
    (if res.deployments ? agent-scheduler then [ ]
     else [ "deployments.agent-scheduler (scheduler.enable = true rendered nothing)" ])
    ++ (if builtins.any (e: e.name == "SCHEDULER_TICK_SECONDS" || e.name == "TICK_SECONDS") schedEnv
        then [ ] else [ "scheduler.env tick (scheduler cannot know its cadence)" ]);

  # OBSERVABILITY (enabled in the example): the agent-host must be told metrics are on AND
  # receive the OTLP endpoint from otel.env — a half-wired exporter reports nothing while
  # looking configured.
  otelProblems =
    (if builtins.any (e: e.name == "OTEL_METRICS_ENABLED") hostEnv then [ ]
     else [ "host.env.OTEL_METRICS_ENABLED (observability.otel.enable = true not wired)" ])
    ++ (if builtins.any (e: e.name == "OTEL_EXPORTER_OTLP_ENDPOINT") hostEnv then [ ]
        else [ "host.env.OTEL_EXPORTER_OTLP_ENDPOINT (otel.env not passed through)" ]);

  # COVERAGE GUARD. examples/kubenix-config.nix is the maintained "every feature enabled"
  # reference AND the fixture these assertions run against — so a NEW top-level namespace that
  # the example never sets means the example (and the docs that point at it) silently fell
  # behind. Listed exceptions are namespaces a reference config legitimately leaves at its
  # default; everything else must appear.
  allNamespaces = builtins.attrNames (platform.options.agentSandbox or { });
  exampleText = builtins.readFile ./kubenix-config.nix;
  # Left at defaults on purpose: `core` is not a namespace (bare agentSandbox.* options are
  # covered elsewhere in the example), the conversation controller is ON by default, postgres
  # is provisioned implicitly by the features that need it, and legacyStateMigration is a
  # one-shot upgrade path rather than a feature to showcase.
  # Image/identity/runtime knobs are deployment-specific plumbing a reference config should
  # NOT hardcode (they default off registryPrefix, which the example does set); the
  # conversation controller is ON by default; postgres is provisioned implicitly by the
  # features that need it; legacyStateMigration is a one-shot upgrade path, not a feature.
  # defaultSandboxSizeName is readOnly — derived from the sandboxSizes preset marked
  # `default = true`, so a config CANNOT set it. The sizeGuard checks below cover it
  # instead, which is stronger than a mention in the example.
  # `db` is declared by the MODULES that own each service (agentSandbox.db.<database>,
  # #606), not by a deployment — a reference config setting it would be describing
  # lib/sql, which is in-tree. `dbSpec` is readOnly, rendered from it. Both are checked
  # far more strongly than a mention here: `just db-generate-check` regenerates
  # owners.toml and atlas.hcl from the option and fails CI on any drift.
  coverageExempt = [
    "conversationController" "postgres" "legacyStateMigration"
    "sandboxRuntimeClass" "serviceAccountRoleArn"
    "agentHostImage" "sandboxImage" "uiImage" "defaultSandboxSizeName"
    "db" "dbSpec"
  ];
  uncovered = builtins.filter
    (n: !(builtins.elem n coverageExempt)
        && builtins.match ".*[^a-zA-Z]${n}[^a-zA-Z].*" exampleText == null)
    allNamespaces;
  coverageProblems = map (n: "example never sets agentSandbox.${n} (add it, or add to coverageExempt with a reason)") uncovered;

  # GATED SKILLS: a skill for a capability that is not wired teaches the agent to call a
  # route that 404s, and then to misread that 404 as the feature being broken. Render the
  # platform with each gate on and off and assert the skill follows.
  # mkForce: a gate the EXAMPLE already sets would otherwise conflict, not override.
  skillsWith = brokerOverride: let
    e = flake.inputs.kubenix.evalModules.${system} {
      module = { lib, ... }: {
        imports = [ ./kubenix-config.nix ];
        agentSandbox.broker = brokerOverride lib;
      };
    };
    cms = e.config.kubernetes.resources.configMaps or { };
  in if cms ? agent-skills then builtins.attrNames cms.agent-skills.data else [ ];
  gateProblems = file: gate: override: let
    shipped = enable: builtins.elem file (skillsWith (override enable));
  in (if shipped true then [ ] else [ "${file} missing when ${gate} = true" ])
     ++ (if shipped false then [ "${file} SHIPPED when ${gate} = false (the agent will chase a 404)" ] else [ ]);
  # One override per contrib that ships skills. Written out rather than derived,
  # because enabling a provider can require its OTHER options (grafana a url, slack a
  # token secret) — a bare `enable = true` would be an eval error, not a render. For a
  # provider the example already configures, mkForce on `enable` is the whole override.
  skillGates = {
    grafana = enable: lib: { grafana = { enable = lib.mkForce enable; url = "https://example.grafana.net"; }; };
    airtable = enable: lib: { airtable.enable = lib.mkForce enable; };
    aws = enable: lib: { aws.enable = lib.mkForce enable; };
    datadog = enable: lib: { datadog.enable = lib.mkForce enable; };
    slack = enable: lib: {
      slack = {
        enable = lib.mkForce enable;
        botTokenSecret = { name = "slack-bot"; key = "SLACK_BOT_TOKEN"; };
      };
    };
  };
  # Driven off contrib/skills.nix — the SAME source platform.nix ships from — so a
  # contrib that starts shipping a skill fails here until its gate is proven.
  nixpkgsLib = flake.inputs.nixpkgs.lib;
  contribSkills = import ../contrib/skills.nix { lib = nixpkgsLib; };
  skillProblems = nixpkgsLib.concatLists (nixpkgsLib.mapAttrsToList
    (name: skills:
      if !(skillGates ? ${name})
      then [ ("contrib ${name} ships ${toString (builtins.attrNames skills)} but examples/check.nix has no gate case — add one to skillGates") ]
      else nixpkgsLib.concatMap
        (file: gateProblems file "broker.${name}.enable" skillGates.${name})
        (builtins.attrNames skills))
    contribSkills);

  # IMMUTABLE-JOB GUARD. A Job's spec.template CANNOT be patched, so re-applying a
  # CHANGED deploy-time Job under a FIXED name is rejected by the apiserver ("field is
  # immutable") — which does not merely skip the Job, it fails the whole deploy (helm
  # reports UPGRADE FAILED and abandons the release with Deployments half-rolled) while
  # the migration silently never runs, because nothing ever creates a new pod for it.
  # Both deploy-time Jobs therefore hash their spec into their NAME, so a spec change is
  # a CREATE. Assert the hash actually MOVES with the spec: a name merely decorated with
  # a constant suffix reads as "hashed" and still wedges every upgrade.
  jobNameOf = p: name: p.config.kubernetes.resources.jobs.${name}.metadata.name or "";
  bumpedMigrator = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.dbMigrate.image = lib.mkForce "example.test/agent-db-migrator:next";
    };
  };
  bumpedInit = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.postgres.kubectlImage = lib.mkForce "example.test/kubectl:next";
    };
  };
  isHashed = base: n: builtins.match "${base}-[0-9a-f]{10}" n != null;
  jobImmutabilityProblems = builtins.concatLists (map
    ({ job, bumped, what }:
      let here = jobNameOf platform job; there = jobNameOf bumped job; in
      (if isHashed job here then [ ]
       else [ "jobs.${job}: metadata.name is '${here}', not ${job}-<spec hash> (a fixed name cannot be re-applied after a spec change)" ])
      ++ (if here != there then [ ]
          else [ "jobs.${job}: changing ${what} did NOT change the name ('${here}') — the next upgrade patches an immutable spec.template and fails the deploy" ])
      # Determinism: the SAME config must render the SAME name, or every deploy
      # re-creates the Job (and the k8s-diff of a no-op deploy is never empty).
      ++ (if here == jobNameOf prodPlatform job then [ ]
          else [ "jobs.${job}: two renders of the same config disagree on the name ('${here}' vs '${jobNameOf prodPlatform job}')" ]))
    [
      { job = "agent-db-migrate"; bumped = bumpedMigrator; what = "dbMigrate.image"; }
      { job = "agent-postgres-init"; bumped = bumpedInit; what = "postgres.kubectlImage"; }
    ]);

  # SIZE-DEFAULT GUARD: exactly one sandboxSizes preset may set `default = true`.
  # kubenix has no NixOS `assertions` option, so that rule is enforced by a `throw` in
  # agentSandbox.defaultSandboxSizeName — and a throw only fires when something READS
  # the option. The agent-host always reads it (it renders SANDBOX_RESOURCES), so the
  # guard always has teeth. A guard that silently stops firing is worse than no guard,
  # so pin both directions here rather than trusting it.
  renderSizes = sizes:
    let
      e = flake.inputs.kubenix.evalModules.${system} {
        module = { lib, ... }: {
          imports = [ ./kubenix-config.nix ];
          agentSandbox.sandboxSizes = lib.mkForce sizes;
        };
      };
    in (builtins.tryEval (builtins.deepSeq e.config.kubernetes.resources true)).success;

  sizeGuardProblems =
    (if renderSizes { a = { cpu = "1"; memory = "2Gi"; default = true; }; b = { cpu = "2"; memory = "4Gi"; }; }
     then [ ] else [ "a catalog with exactly one `default = true` failed to render" ])
    ++ (if renderSizes { a = { cpu = "1"; memory = "2Gi"; }; b = { cpu = "2"; memory = "4Gi"; }; }
        then [ "a catalog with NO `default = true` rendered — the guard is a no-op" ] else [ ])
    ++ (if renderSizes { a = { cpu = "1"; memory = "2Gi"; default = true; }; b = { cpu = "2"; memory = "4Gi"; default = true; }; }
        then [ "a catalog with TWO `default = true` rendered — the guard is a no-op" ] else [ ]);

  # OWNER ATTRIBUTION (#527). The ROUTER stamps spec.owner on create and scopes the
  # conversation list, so it needs (a) the identity config the agent-host gets, and (b) the
  # SA allowlist + TokenReview grant that let webhooks/scheduler pass a resolved owner in
  # the create body. All three were absent, and the failure was SILENT — conversations were
  # created unowned and then hidden from the person who started the Slack thread — so pin
  # them at render time. The alb-oidc render is the case that could not work at all before:
  # the router read x-auth-user, which an ALB never sets.
  routerEnv =
    let ctrs = builtins.attrValues (res.deployments.conversation-router.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  routerEnvVal = name: let m = builtins.filter (e: e.name == name) routerEnv; in if m == [ ] then "" else (builtins.head m).value;
  albPlatform = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.auth.mode = lib.mkForce "alb-oidc";
    };
  };
  albRouterEnv =
    let ctrs = builtins.attrValues (albPlatform.config.kubernetes.resources.deployments.conversation-router.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  ownerProblems =
    (if builtins.match ".*:agent-webhooks.*" (routerEnvVal "WEBHOOKS_SERVICE_ACCOUNT") != null then [ ]
     else [ "router.env.WEBHOOKS_SERVICE_ACCOUNT (a webhooks-resolved conversation owner is dropped)" ])
    ++ (if builtins.match ".*:agent-scheduler.*" (routerEnvVal "WEBHOOKS_SERVICE_ACCOUNT") != null then [ ]
        else [ "router.env.WEBHOOKS_SERVICE_ACCOUNT omits the scheduler SA (scheduled-task owners are dropped)" ])
    ++ (if routerEnvVal "WEBHOOKS_TOKEN_AUDIENCE" != "" then [ ]
        else [ "router.env.WEBHOOKS_TOKEN_AUDIENCE (TokenReview rejects the caller's projected token)" ])
    ++ (if (res.clusterRoleBindings or { }) ? conversation-router-tokenreview then [ ]
        else [ "clusterRoleBindings.conversation-router-tokenreview (TokenReview 403s, so every webhook conversation is unowned)" ])
    ++ (if builtins.any (e: e.name == "AUTH_MODE" && e.value == "alb-oidc") albRouterEnv then [ ]
        else [ "alb-oidc: router.env.AUTH_MODE (the router reads x-auth-user, which an ALB never sets — every caller looks anonymous and sees every conversation)" ]);

  # THE SHARED BROKER DATABASE reaches the broker regardless of which feature wants
  # it. Every broker store (aws permission requests, the module registry, static
  # shares) resolves its DSN from BROKER_DB_*, and a store that finds no password
  # falls back to a SQLite dev path — persisting to the pod's disk and losing
  # everything on restart, with nothing logged. These used to be AWS_DB_*, emitted
  # from the aws branch and mirrored in a `!aws.enable` branch to keep shares
  # working; the mirror covered shares but nothing covered registry-only, and
  # keeping two copies disjoint was hand-maintained. So assert BOTH halves of what
  # replaced it: present with aws OFF, and never declared twice with aws ON (k8s
  # silently keeps the last value of a duplicated env name).
  awsOffPlatform = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.broker.aws.enable = lib.mkForce false;
      agentSandbox.broker.shares.enable = lib.mkForce false;
    };
  };
  awsOffBrokerEnv =
    let ctrs = builtins.attrValues (awsOffPlatform.config.kubernetes.resources.deployments.agent-broker.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  dbEnvNames = [ "BROKER_DB_HOST" "BROKER_DB_PORT" "BROKER_DB_NAME" "BROKER_DB_USER" "BROKER_DB_PASSWORD" ];
  countNamed = env: n: builtins.length (builtins.filter (e: e.name == n) env);
  brokerDbProblems =
    map (n: "aws-off: broker.env.${n} missing — every broker store silently falls back to SQLite and loses its data on restart")
      (builtins.filter (n: countNamed awsOffBrokerEnv n == 0) dbEnvNames);

  # NO env name may be declared twice on the broker container — widened from the
  # BROKER_DB_* set above now that a contrib appends its own entries through
  # broker.extraEnv (#599). k8s accepts a duplicate and silently keeps the LAST
  # value, so a contrib emitting BROKER_DB_HOST would repoint every store in the
  # image with nothing logged and no rollout failure. Checking the whole container
  # means a NEW contrib is covered without editing a list here.
  # attrNames of a set built from the list: this file has no `lib` in scope (it is
  # plain `nix eval`, not a module), and a duplicated name must be reported once.
  brokerEnvNames = builtins.attrNames
    (builtins.listToAttrs (map (e: { name = e.name; value = null; }) brokerEnv));
  dupEnvProblems = map
    (n: "broker.env.${n} declared more than once (k8s keeps the LAST value silently — a contrib's broker.extraEnv must not reuse a core name)")
    (builtins.filter (n: countNamed brokerEnv n > 1) brokerEnvNames);

  # A CONTRIB'S DEPLOYMENT MODULE REACHES THE BROKER DEPLOYMENT. aws's option tree
  # and its manifests live in contrib/aws/deployment.nix, which modules/platform.nix
  # imports without naming it (contrib/deployment-modules.nix) — so this asserts the
  # seams carry, rather than that the file exists. All four kinds in one render, each
  # of which was an inline `lib.optionals bcfg.aws.enable` in modules/broker.nix:
  #   env         -> AWS_ENABLED           (broker.extraEnv)
  #   volume+mount-> aws-accounts          (broker.extraVolumes/extraVolumeMounts)
  #   annotation  -> checksum/aws-accounts (broker.podAnnotations, csProblems above)
  #   a resource  -> the accounts ConfigMap
  # And the negative half, which is the one a seam gets wrong: with aws OFF nothing
  # of it may reach the pod. A seam wired unconditionally would pass every positive
  # check here and quietly mount a ConfigMap that does not exist.
  brokerCtr = res.deployments.agent-broker.spec.template.spec.containers.agent-broker;
  awsOffCtrs = builtins.attrValues (awsOffPlatform.config.kubernetes.resources.deployments.agent-broker.spec.template.spec.containers or { });
  hasName = l: n: builtins.any (v: v.name == n) l;
  contribSeamProblems =
    (if countNamed brokerEnv "AWS_ENABLED" == 1 then [ ]
     else [ "broker.env.AWS_ENABLED — contrib/aws/deployment.nix did not reach the broker container through broker.extraEnv" ])
    ++ (if hasName (brokerCtr.volumeMounts or [ ]) "aws-accounts" then [ ]
        else [ "broker.volumeMounts aws-accounts missing (broker.extraVolumeMounts) — the provider reads accounts.json off disk and finds nothing" ])
    ++ (if hasName (res.deployments.agent-broker.spec.template.spec.volumes or [ ]) "aws-accounts" then [ ]
        else [ "broker.volumes aws-accounts missing (broker.extraVolumes) — the mount above has no source" ])
    ++ (if (res.configMaps or { }) ? agent-broker-aws-accounts then [ ]
        else [ "configMaps.agent-broker-aws-accounts missing — a contrib's deployment module cannot render its own resources" ])
    ++ (if builtins.all (c: !(hasName (c.volumeMounts or [ ]) "aws-accounts")) awsOffCtrs then [ ]
        else [ "aws-off: broker still mounts aws-accounts — the seam is wired unconditionally, so the pod mounts a ConfigMap that is not rendered" ])
    ++ (if builtins.all (c: countNamed (c.env or [ ]) "AWS_ENABLED" == 0) awsOffCtrs then [ ]
        else [ "aws-off: broker.env.AWS_ENABLED present — contrib env is not gated on the contrib's own enable" ]);

  # OPENFGA IS SUBSTRATE, NOT AWS'S. The authorizer core/authz.py builds from FGA_*
  # is handed to every provider through BrokerContext (#624), so `broker.fga` is a
  # core option: a second feature wanting an approver gate must not have to enable
  # aws to get one. The render that proves it is fga ON with aws OFF — under the old
  # `broker.aws.fga` that combination could not be expressed at all.
  fgaNoAwsPlatform = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.broker.aws.enable = lib.mkForce false;
      agentSandbox.broker.fga.enable = true;
    };
  };
  fnaRes = fgaNoAwsPlatform.config.kubernetes.resources;
  fnaBrokerEnv = builtins.concatMap (c: c.env or [ ])
    (builtins.attrValues (fnaRes.deployments.agent-broker.spec.template.spec.containers or { }));
  fgaProblems =
    (if (fnaRes.deployments or { }) ? openfga then [ ]
     else [ "fga-without-aws: deployments.openfga missing — the authorization server is still gated on an integration" ])
    ++ (if countNamed fnaBrokerEnv "FGA_ENABLED" == 1 then [ ]
        else [ "fga-without-aws: broker.env.FGA_ENABLED missing — the broker builds a NoopAuthorizer and every approver check passes" ])
    ++ (if (fgaNoAwsPlatform.config.agentSandbox.postgres.consumers or { }) ? openfga then [ ]
        else [ "fga-without-aws: postgres.consumers.openfga missing — openfga has no database or role" ]);

  # THE APPROVER ALLOWLIST IS CORE AUTH'S, NOT AWS'S. core/auth.py admits a listed
  # SA as a non-sandbox caller and sets Identity.is_approver; TWO features read that
  # flag — aws approve/deny, and shares' "list another conversation's shares", which
  # the UI reaches through the agent-host. The list used to be emitted only inside
  # `bcfg.aws.enable`, so a deployment running shares WITHOUT aws sent an agent-host
  # that core auth saw as a stranger: 403 on the UI's own list request, from a
  # feature that has nothing to do with aws.
  #
  # The render that proves it is aws OFF with shares ON — #625's awsOffPlatform
  # forces BOTH off, so it cannot see this. Assert the env is present there, and
  # that it names the agent-host (an empty value parses to an empty set, which
  # authenticates nobody and would pass a mere presence check).
  sharesNoAwsPlatform = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.broker.aws.enable = lib.mkForce false;
      # shares.enable stays true (the example sets it) — that is the point.
    };
  };
  snaBrokerEnv =
    let ctrs = builtins.attrValues (sharesNoAwsPlatform.config.kubernetes.resources.deployments.agent-broker.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  snaApprover =
    let m = builtins.filter (e: e.name == "APPROVER_SERVICE_ACCOUNTS") snaBrokerEnv;
    in if m == [ ] then "" else (builtins.head m).value or "";
  approverProblems =
    (if snaApprover != "" then [ ]
     else [ ("shares-without-aws: broker.env.APPROVER_SERVICE_ACCOUNTS missing or empty"
             + " — the agent-host is not an approver, so the UI's cross-conversation"
             + " share listing 403s") ])
    ++ (if builtins.match ".*:agent-host" snaApprover != null then [ ]
        else [ "broker.env.APPROVER_SERVICE_ACCOUNTS does not name the agent-host: '${snaApprover}'" ]);

  # TLS TO POSTGRES REACHES EVERY CONSUMER. Each service assembles its own DSN from
  # separately-emitted components, and each emission site is hand-written — 11 of them
  # across 8 module files. The failure mode is a MISSING component, not a wrong one:
  # sslmode is absent, the DSN carries no ssl parameter, and the service connects in
  # cleartext to a server the deployment asked to reach over TLS. Nothing fails and
  # nothing logs. #621 was one copy of exactly that (the broker's), and byoc-controller
  # still had it afterwards — index.ts read DB_SSLMODE while modules/byoc.nix never
  # emitted it — because "fix the copy you found" cannot catch the copy you didn't.
  #
  # So don't enumerate the consumers here: DERIVE the expectation from what each
  # workload emits. Any container with a `<prefix>DB_HOST` is talking to Postgres and
  # must also carry `<prefix>DB_SSLMODE` once the deployment sets one. A twelfth copy
  # that forgets it fails this check on the day it lands, and a new consumer is covered
  # without editing this file. Needs a NON-cluster render: in-cluster leaves sslmode
  # null by design, so the example platform emits nothing and proves nothing.
  tlsPlatform = flake.inputs.kubenix.evalModules.${system} {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      agentSandbox.postgres.external = {
        host = "pg.example.invalid";
        sslmode = "require";
        user = "postgres";
        passwordSecret = { name = "pg-admin"; key = "password"; };
      };
    };
  };
  tlsRes = tlsPlatform.config.kubernetes.resources;
  # Every container of every workload kind, so a new Deployment/Job is covered too.
  allWorkloads = builtins.concatMap
    (kind: builtins.attrValues (tlsRes.${kind} or { }))
    [ "deployments" "statefulSets" "jobs" "cronJobs" ];
  containersOf = w:
    let spec = w.spec.template.spec or (w.spec.jobTemplate.spec.template.spec or { });
    in builtins.attrValues (spec.containers or { });
  # "AGENT_HOST_DB_HOST" -> "AGENT_HOST_DB_", "DB_HOST" -> "DB_"
  prefixOf = name: builtins.substring 0 (builtins.stringLength name - 4) name;
  # A derived check can pass by scanning nothing — if the render carried no DB_HOST at
  # all, `missing` would be empty everywhere and this would report green while testing
  # zero consumers. So count what was actually examined and fail if it collapses.
  dbHostCount = builtins.length (builtins.concatMap
    (w: builtins.concatMap
      (c: builtins.filter (n: builtins.match ".*DB_HOST" n != null) (map (e: e.name) (c.env or [ ])))
      (containersOf w))
    allWorkloads);
  vacuityProblems = if dbHostCount >= 6 then [ ]
    else [ ("sslmode guard scanned only ${toString dbHostCount} DB_HOST vars (expected >= 6)"
            + " — the render or the scan broke, and the check is passing vacuously") ];

  sslProblems = builtins.concatMap
    (w: builtins.concatMap
      (c:
        let
          env = c.env or [ ];
          names = map (e: e.name) env;
          hosts = builtins.filter (n: builtins.match ".*DB_HOST" n != null) names;
          missing = builtins.filter
            (h: !(builtins.elem "${prefixOf h}SSLMODE" names)) hosts;
        in map (h: "${w.metadata.name or "?"}: emits ${h} but no ${prefixOf h}SSLMODE "
                 + "(cleartext to a TLS-only Postgres, silently)") missing)
      (containersOf w))
    allWorkloads;

  allProblems = oneEntrypointProblems ++ ownerProblems ++ jobImmutabilityProblems ++ sizeGuardProblems ++ skillProblems ++ problems ++ ddProblems ++ atProblems ++ sharesProblems ++ cfProblems ++ csProblems ++ dbProblems ++ puProblems ++ mdProblems ++ ngProblems ++ rolloutProblems ++ testProblems ++ schedProblems ++ otelProblems ++ coverageProblems ++ brokerDbProblems ++ dupEnvProblems ++ contribSeamProblems ++ fgaProblems ++ sslProblems ++ vacuityProblems ++ approverProblems;
in
if allProblems == [ ]
then "ok: deployments = ${haveDeps}; datadog + airtable + configFiles + broker config-rollout + models + scheduler + otel wired; example covers every option namespace; skills gated on their capability; sandbox-shaping env is agent-host-only (one provisioning entrypoint); sandbox size default guard fires on 0 and 2 defaults; deploy-time Jobs are spec-hash named\n"
else builtins.throw "example manifests missing: ${builtins.concatStringsSep ", " allProblems}"
