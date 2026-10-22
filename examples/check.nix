# Render check for the example platform config (`nix eval -f examples/check.nix`,
# via `just check-manifests`). Renders examples/kubenix-config.nix and asserts the
# expected resources and wiring are present, catching eval errors and silent
# resource drops that a plain build renders as a valid-but-wrong manifest set.
let
  flake = builtins.getFlake (toString ../.);
  system = builtins.currentSystem;
  # The vended entry point: it loads platform.nix and the image modules.
  evalPlatform = { module }: flake.lib.evalPlatform { inherit system module; };

  platform = evalPlatform {
    module = ./kubenix-config.nix;
  };

  res = platform.config.kubernetes.resources;

  # resource-kind -> names the platform must render with all features enabled.
  expect = {
    # byoc-controller renders from `byoc.enable = true` alone.
    deployments = [ "agent-host" "agent-broker" "agent-webhooks" "ui" "warm-store-controller" "byoc-controller" ];
    services = [ "agent-host" "agent-host-pods" "agent-broker" "agent-webhooks" "ui" ];
    # deploy-config-files is the deployTools.configFiles ConfigMap.
    configMaps = [ "agent-skills" "deploy-config-files" ];
  };

  missingFor = kind: want:
    let have = builtins.attrNames (res.${kind} or { });
    in builtins.filter (n: !(builtins.elem n have)) want;

  problems = builtins.concatLists (builtins.attrValues (builtins.mapAttrs
    (kind: want: map (n: "${kind}.${n}") (missingFor kind want))
    expect));

  haveDeps = builtins.concatStringsSep ", " (builtins.attrNames (res.deployments or { }));

  # The datadog provider must wire its secret env into the broker, or it stays disabled.
  brokerEnv =
    let ctrs = builtins.attrValues (res.deployments.agent-broker.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  ddWired = builtins.any (e: e.name == "DATADOG_API_KEY") brokerEnv;
  ddProblems = if ddWired then [ ] else [ "broker.env.DATADOG_API_KEY (datadog provider not wired)" ];

  # Same for airtable.
  atProblems = if builtins.any (e: e.name == "AIRTABLE_TOKEN") brokerEnv then [ ]
    else [ "broker.env.AIRTABLE_TOKEN (airtable provider not wired)" ];

  # Web search: each enabled provider's key reaches the broker from its own secret,
  # several providers render together, and keyless duckduckgo renders its switch.
  searchKeyRef = env:
    let m = builtins.filter (e: e.name == env) brokerEnv;
    in if m == [ ] then { } else ((builtins.head m).valueFrom.secretKeyRef or { });
  searchProblems =
    (if (searchKeyRef "BRAVE_SEARCH_API_KEY").name or "" == "brave-search-key" then [ ]
     else [ "broker.env.BRAVE_SEARCH_API_KEY (brave.enable = true not wired, so the agent has no brave_web_search)" ])
    ++ (if (searchKeyRef "KAGI_API_KEY").name or "" == "kagi-search-key" then [ ]
        else [ "broker.env.KAGI_API_KEY (kagi.enable = true not wired — two search providers must both render)" ])
    ++ (if builtins.any (e: e.name == "DUCKDUCKGO_ENABLED" && (e.value or "") == "true") brokerEnv then [ ]
        else [ "broker.env.DUCKDUCKGO_ENABLED (duckduckgo.enable = true not wired, so the keyless provider stays off)" ]);

  # Static shares: the broker must carry SHARES_ENABLED and a derived public base URL.
  sharesEnvVal = name: let m = builtins.filter (e: e.name == name) brokerEnv; in if m == [ ] then "" else (builtins.head m).value;
  sharesProblems =
    (if builtins.any (e: e.name == "SHARES_ENABLED") brokerEnv then [ ]
     else [ "broker.env.SHARES_ENABLED (shares.enable = true not wired)" ])
    ++ (if builtins.match "https://.+" (sharesEnvVal "SHARES_PUBLIC_BASE_URL") != null then [ ]
        else [ "broker.env.SHARES_PUBLIC_BASE_URL (should derive from ingress.host)" ]);

  # deployTools.configFiles must render its ConfigMap and tell the agent-host to mount it.
  hostEnv =
    let ctrs = builtins.attrValues (res.deployments.agent-host.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  cfWired = builtins.any (e: e.name == "SCOOTER_CONFIG_FILES_CONFIGMAP") hostEnv;
  cfHasFile = (res.configMaps.deploy-config-files.data or { }) ? "nix.conf";
  cfProblems =
    (if cfWired then [ ] else [ "host.env.SCOOTER_CONFIG_FILES_CONFIGMAP (configFiles not wired)" ])
    ++ (if cfHasFile then [ ] else [ "configMaps.deploy-config-files.data.nix.conf (file missing)" ]);

  # A sandbox can reach the broker but not the agent-host, so sandbox-shaping config
  # must stay off the broker.
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

  # The fields a seamless rollout depends on: surge strategy and an emptyDir state
  # volume.
  ahDep = res.deployments.agent-host.spec or { };
  ahStrategy = ahDep.strategy or { };
  ahRolling = ahStrategy.rollingUpdate or { };
  stateVol = builtins.head (builtins.filter (v: v.name == "state")
    (res.deployments.agent-host.spec.template.spec.volumes or [ ]) ++ [ { } ]);
  rolloutProblems =
    (if (ahStrategy.type or "") == "RollingUpdate" then [ ] else [ "agent-host.strategy.type != RollingUpdate (needs surge, not Recreate/STS)" ])
    ++ (if (ahRolling.maxUnavailable or null) == 0 then [ ] else [ "agent-host.strategy.maxUnavailable != 0 (a rollout would drop capacity)" ])
    ++ (if (ahRolling.maxSurge or null) == 1 then [ ] else [ "agent-host.strategy.maxSurge != 1 (no new-pod-before-old-drains)" ])
    ++ (if (stateVol ? emptyDir) then [ ] else [ "agent-host `state` volume is not an emptyDir (a per-pod PVC blocks surge via Multi-Attach)" ]);

  # The model catalog must render AGENT_MODELS_JSON and a derived GOOSE_MODEL into
  # the agent-host env, which the example's fakeAgent gates off, so render a non-fake
  # platform.
  modelPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.fakeAgent = lib.mkForce false;
      scooter.agent.availableModels.goose."us.anthropic.claude-opus-4-8".contextLimit = 1000000;
      scooter.agent.env.GOOSE_MAX_TURNS = "200";
      scooter.agent.envPassthrough = [ "GOOSE_TOOLSHIM" ];
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
        else [ "AGENT_MODELS_JSON: sonnet should be default:true with a hint" ])
    ++ (if (builtins.head (opusEntry ++ [ { } ])).contextLimit or null == 1000000 then [ ]
        else [ "AGENT_MODELS_JSON: opus should carry contextLimit 1000000" ])
    ++ (if sonnetEntry != [ ] && !((builtins.head sonnetEntry) ? contextLimit) then [ ]
        else [ "AGENT_MODELS_JSON: sonnet declares no contextLimit, so it must render none" ])
    ++ (if mEnvVal "GOOSE_MAX_TURNS" == "200" then [ ]
        else [ "agent.env.GOOSE_MAX_TURNS not rendered onto the agent-host" ])
    ++ (if mEnvVal "AGENT_ENV_PASSTHROUGH" == "GOOSE_TOOLSHIM,GOOSE_MAX_TURNS" then [ ]
        else [ "AGENT_ENV_PASSTHROUGH should be 'GOOSE_TOOLSHIM,GOOSE_MAX_TURNS', got '${mEnvVal "AGENT_ENV_PASSTHROUGH"}'" ])
    ++ (let ctrs = builtins.attrValues (clashPlatform.config.kubernetes.resources.deployments.agent-host.spec.template.spec.containers or { });
        in if !(builtins.tryEval (builtins.deepSeq (map (c: c.env or [ ]) ctrs) true)).success then [ ]
           else [ "agent.env.GOOSE_PROVIDER should throw (the platform already sets it)" ]);
  opusEntry = builtins.filter (m: m.id == "us.anthropic.claude-opus-4-8") parsedModels;
  clashPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.fakeAgent = lib.mkForce false;
      scooter.agent.env.GOOSE_PROVIDER = "anthropic";
    };
  };

  # With no `goose` provider group the global default falls through to a provider's
  # explicit `default`, which here is `claude-opus-5` even though `claude-fable-5`
  # sorts ahead of it.
  noGoosePlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.fakeAgent = lib.mkForce false;
      scooter.agent.availableModels = lib.mkForce {
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

  # contribs.aws must stamp a checksum/aws-accounts annotation on the broker pod
  # template, so editing an account rolls the pod.
  brokerAnno = res.deployments.agent-broker.spec.template.metadata.annotations or { };
  awsChecksumWired = brokerAnno ? "checksum/aws-accounts";
  csProblems = if awsChecksumWired then [ ]
    else [ "broker.template.annotations.checksum/aws-accounts (config-rollout annotation missing)" ];

  # Both shared-Postgres probes must carry a generous timeout, since the 1s default
  # restart-loops the DB under load.
  dbCtr = platform.config.kubernetes.resources.deployments.agent-shared-db.spec.template.spec.containers.postgres;
  dbTimeoutOk = (dbCtr.livenessProbe.timeoutSeconds or 1) >= 3 && (dbCtr.readinessProbe.timeoutSeconds or 1) >= 3;
  dbProblems = if dbTimeoutOk then [ ]
    else [ "postgres probe timeoutSeconds too tight (< 3s) — the 1s default caused a restart-loop outage" ];

  # With the chat ingress disabled but a host set, PUBLIC_URL and AGENT_MANAGER_URL
  # must still populate from the host while no chat Ingress renders.
  ingressOffPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.ingress.enable = lib.mkForce false;
    };
  };
  ioRes = ingressOffPlatform.config.kubernetes.resources;
  envVal = dep: name:
    let
      # Look in both workload kinds.
      workload = ioRes.deployments.${dep} or ioRes.statefulSets.${dep} or null;
      ctrs = builtins.attrValues (workload.spec.template.spec.containers or { });
      env = builtins.concatMap (c: c.env or [ ]) ctrs;
      m = builtins.filter (e: e.name == name) env;
    in if m == [ ] then "" else (builtins.head m).value;
  publicUrlSet = builtins.match "https://.+" (envVal "agent-host" "PUBLIC_URL") != null;
  managerUrlSet = builtins.match "https://.+" (envVal "agent-webhooks" "AGENT_MANAGER_URL") != null;
  noChatIngress = !(ioRes.ingresses.agent-host or null != null);
  puProblems =
    (if publicUrlSet then [ ] else [ "ingress-disabled: PUBLIC_URL empty (should derive from host)" ])
    ++ (if managerUrlSet then [ ] else [ "ingress-disabled: AGENT_MANAGER_URL empty (should derive from host)" ])
    ++ (if noChatIngress then [ ] else [ "ingress-disabled: a chat Ingress was rendered anyway (competing router)" ]);

  # A production render must carry none of modules/testing.nix's affordances, asserted
  # on the rendered manifest rather than the option plumbing.
  prodPlatform = evalPlatform {
    module = { ... }: { imports = [ ./kubenix-config.nix ]; };
  };
  prodRes = prodPlatform.config.kubernetes.resources;
  prodHostEnv =
    let ctrs = builtins.attrValues (prodRes.deployments.agent-host.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  hasEnv = name: builtins.any (e: e.name == name) prodHostEnv;
  # The example sets fakeAgent directly; what matters is that the testing module's
  # own artifacts never appear without importing it.
  testProblems =
    (if !(prodRes.configMaps ? agent-testing-marker) then [ ]
     else [ "production render carries the agent-testing-marker ConfigMap (testing.nix leaked in)" ])
    ++ (if !(prodPlatform.options.scooter ? testing) then [ ]
        else [ "scooter.testing option exists WITHOUT importing modules/testing.nix (a deploy could set it)" ]);

  # The scheduler must render its Deployment and carry its tick.
  schedEnv =
    let ctrs = builtins.attrValues (res.deployments.agent-scheduler.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  schedProblems =
    (if res.deployments ? agent-scheduler then [ ]
     else [ "deployments.agent-scheduler (scheduler.enable = true rendered nothing)" ])
    ++ (if builtins.any (e: e.name == "SCHEDULER_TICK_SECONDS" || e.name == "TICK_SECONDS") schedEnv
        then [ ] else [ "scheduler.env tick (scheduler cannot know its cadence)" ]);

  # The agent-host must be told metrics are on and receive the OTLP endpoint from otel.env.
  otelProblems =
    (if builtins.any (e: e.name == "OTEL_METRICS_ENABLED") hostEnv then [ ]
     else [ "host.env.OTEL_METRICS_ENABLED (observability.otel.enable = true not wired)" ])
    ++ (if builtins.any (e: e.name == "OTEL_EXPORTER_OTLP_ENDPOINT") hostEnv then [ ]
        else [ "host.env.OTEL_EXPORTER_OTLP_ENDPOINT (otel.env not passed through)" ]);

  # Coverage guard: every top-level scooter.* namespace the example never sets means
  # the reference config fell behind, except the listed defaults.
  allNamespaces = builtins.attrNames (platform.options.scooter or { });
  exampleText = builtins.readFile ./kubenix-config.nix;
  # Exempt: on-by-default or implicitly provisioned services, a one-shot upgrade
  # path, deployment-specific image/identity/runtime knobs, readOnly derived options
  # (defaultSandboxSizeName, dbSpec), and the contrib seams (db, sandboxPod,
  # approvals) that the seam checks below cover more strongly.
  coverageExempt = [
    "conversationController" "postgres" "legacyStateMigration"
    "sandboxRuntimeClass" "serviceAccountRoleArn"
    "agentHostImage" "sandboxImage" "uiImage" "defaultSandboxSizeName"
    "db" "dbSpec" "sandboxPod" "approvals"
    # declared per-service module; a deployer overrides a ref, not the tree
    "images" "imagesContentTag"
  ];
  uncovered = builtins.filter
    (n: !(builtins.elem n coverageExempt)
        && builtins.match ".*[^a-zA-Z]${n}[^a-zA-Z].*" exampleText == null)
    allNamespaces;
  coverageProblems = map (n: "example never sets scooter.${n} (add it, or add to coverageExempt with a reason)") uncovered;

  # Same guard for `contribs.*`, exempting no-option and unshipped contribs.
  contribNames = builtins.attrNames platform.config.contribs;
  # Own options = resolved fields minus the shared spec's.
  bareContribs = (nixpkgsLib.evalModules {
    specialArgs = { lib = nixpkgsLib; };
    modules = [ ../contrib/all-modules.nix ];
  }).config.contribs;
  specFields = builtins.attrNames (nixpkgsLib.evalModules {
    specialArgs = { lib = nixpkgsLib; name = "schema"; };
    modules = [ ../contrib/submodule.nix ];
  }).options;
  ownOptions = n: nixpkgsLib.subtractLists specFields (builtins.attrNames bareContribs.${n});
  uncoveredContribs = builtins.filter
    (n: platform.config.contribs.${n}.enable
        && ownOptions n != [ ]
        && builtins.match ".*[^a-zA-Z]${n}[^a-zA-Z].*" exampleText == null)
    contribNames;
  contribCoverageProblems = map
    (n: "example never sets contribs.${n} (it declares ${builtins.toString (ownOptions n)} — configure it, or stop shipping it)")
    uncoveredContribs;

  # A skill ships iff its contrib is built.
  skillsWith = contribOverride: let
    e = evalPlatform {
      module = { lib, ... }: {
        imports = [ ./kubenix-config.nix ];
        contribs = contribOverride lib;
      };
    };
    cms = e.config.kubernetes.resources.configMaps or { };
  in if cms ? agent-skills then builtins.attrNames cms.agent-skills.data else [ ];
  # mkForce the whole attr: dropping a contrib drops its config.
  gateProblems = file: name: let
    shipped = builtins.elem file (skillsWith (lib: { ${name}.enable = lib.mkForce true; }));
    unshippedShips = builtins.elem file
      (skillsWith (lib: { ${name} = lib.mkForce { enable = false; }; }));
  in (if shipped then [ ] else [ "${file} missing when contribs.${name}.enable = true" ])
     ++ (if unshippedShips then [ "${file} SHIPPED when contribs.${name}.enable = false (it is not in the image)" ] else [ ]);
  # Driven off the render's own `contribs` tree, the set platform.nix ships from.
  nixpkgsLib = flake.inputs.nixpkgs.lib;
  contribSkills = nixpkgsLib.mapAttrs (_: c: c.skills)
    (nixpkgsLib.filterAttrs (_: c: c.enable && c.skills != { }) platform.config.contribs);
  skillProblems = (if contribSkills != { } then [ ] else
  [ "no contrib ships a skill — this check reads platform.config.contribs, so an EMPTY set means the contribs stopped reaching the platform eval, not that nobody documents anything" ])
  ++ nixpkgsLib.concatLists (nixpkgsLib.mapAttrsToList
    (name: skills: nixpkgsLib.concatMap (file: gateProblems file name) (builtins.attrNames skills))
    contribSkills);

  # A Job's spec.template cannot be patched, so both deploy-time Jobs hash their
  # spec into their name and the hash must move with the spec.
  jobNameOf = p: name: p.config.kubernetes.resources.jobs.${name}.metadata.name or "";
  bumpedMigrator = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.dbMigrate.image = lib.mkForce "example.test/agent-db-migrator:next";
    };
  };
  bumpedInit = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.postgres.kubectlImage = lib.mkForce "example.test/kubectl:next";
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
      # The same config must render the same name, or every deploy re-creates the Job.
      ++ (if here == jobNameOf prodPlatform job then [ ]
          else [ "jobs.${job}: two renders of the same config disagree on the name ('${here}' vs '${jobNameOf prodPlatform job}')" ]))
    [
      { job = "agent-db-migrate"; bumped = bumpedMigrator; what = "dbMigrate.image"; }
      { job = "agent-postgres-init"; bumped = bumpedInit; what = "postgres.kubectlImage"; }
    ]);

  # Exactly one sandboxSizes preset may set `default = true`, enforced by a `throw`
  # that only fires when something reads the option, so pin both directions.
  renderSizes = sizes:
    let
      e = evalPlatform {
        module = { lib, ... }: {
          imports = [ ./kubenix-config.nix ];
          scooter.sandboxSizes = lib.mkForce sizes;
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

  # A manifest on the removed `agentSandbox.*` root must fail to render; rendered
  # rather than asserted on the option, because the forcing is what can silently break.
  renders = extra:
    let
      e = evalPlatform {
        module = { ... }: {
          imports = [ ./kubenix-config.nix ];
          config = extra;
        };
      };
    in (builtins.tryEval (builtins.deepSeq e.config.kubernetes.resources true)).success;

  # The contribs are modules in the platform eval and `enable` gates what ships,
  # read off the platform eval itself; four claims because each fails in a
  # different direction: an enabled contrib reached the eval, a disabled one
  # contributes no skill, configuring an unshipped one throws, and dropping an
  # unconfigured one still renders.
  disabled = builtins.attrNames (nixpkgsLib.filterAttrs (_: c: !c.enable) platform.config.contribs);

  # The skill files an extra config renders, via the same ConfigMap `skillsWith` reads.
  skillFilesWith = extra:
    let
      e = evalPlatform {
        module = { ... }: {
          imports = [ ./kubenix-config.nix ];
          config = extra;
        };
      };
      cms = e.config.kubernetes.resources.configMaps or { };
    in if cms ? agent-skills then builtins.attrNames cms.agent-skills.data else [ ];

  # A disabled contrib that ships a skill, injected here because the fixture must be
  # a contrib the repo does not ship.
  echoSkillFile = "example-check-disabled-fixture.md";
  echoSkills = skillFilesWith {
    contribs.echo.skills.${echoSkillFile} = ../skills/scooter-intro.md;
  };
  echoSkillsRender = (builtins.tryEval (builtins.deepSeq echoSkills true)).success;

  # Skill DIRECTORIES: echo's fixture ships SKILL.md as echo-skill.md only once echo
  # is built, with the sandbox note after the frontmatter rather than before it
  # (the agent-host reads `description` from frontmatter that must open the file).
  skillDataWith = extra:
    let
      e = evalPlatform {
        module = { ... }: {
          imports = [ ./kubenix-config.nix ];
          config = extra;
        };
      };
    in (e.config.kubernetes.resources.configMaps or { }).agent-skills.data or { };
  echoDirSkill = (skillDataWith { contribs.echo.enable = nixpkgsLib.mkForce true; })."echo-skill.md" or null;
  dirSkillProblems =
    (if builtins.elem "echo-skill.md" echoSkills then
    [ "echo's skill DIRECTORY shipped with echo disabled — skillDirs is not gated on `enable`" ] else [ ])
    ++ (if echoDirSkill == null then
    [ "echo-skill.md is missing with echo enabled — a contrib's skillDirs do not reach the agent-skills ConfigMap" ]
    else if !(nixpkgsLib.hasPrefix "---\nname: echo-skill\n" echoDirSkill) then
    [ "echo-skill.md does not open with its frontmatter — the sandbox note went in front of it, so the agent-host loses the skill's description" ]
    else if !(nixpkgsLib.hasInfix "/etc/scooter/skills/echo-skill" echoDirSkill) then
    [ "echo-skill.md lacks the note naming /etc/scooter/skills/echo-skill — the agent would resolve scripts/ against the agent-host's copy" ]
    else [ ])
    # A `source` with no pin in modules/skills/skills.lock must fail the render, not fetch an unpinned HEAD.
    ++ (if renders {
          contribs.echo.enable = nixpkgsLib.mkForce true;
          contribs.echo.skillDirs.unpinned.source = "github:example/unpinned";
        }
        then [ "a skill directory whose source is not in modules/skills/skills.lock rendered — it must fail and point at `just lock-skills`" ]
        else [ ])
    # Skill directories are a platform feature: a deployment declares one with no
    # contrib, and it ships even with the contribs' own skills turned off.
    ++ (let d = skillDataWith {
              skillDirs.core-skill.path = ../contrib/echo/skills/echo-skill;
              scooter.agent.builtinSkills = false;
            }; in
        if !(d ? "core-skill.md") then
        [ "a deployment-level skillDirs entry did not reach the agent-skills ConfigMap — skill directories only work through a contrib" ]
        else if !(nixpkgsLib.hasInfix "/etc/scooter/skills/core-skill" d."core-skill.md") then
        [ "core-skill.md lacks the note naming /etc/scooter/skills/core-skill" ]
        else [ ]);
  disabledContribProblems =
    (if disabled != [ ] then [ ] else
    [ "every contrib is enabled — the disabled-contrib checks below test nothing; keep one disabled fixture (echo) or delete them" ])
    ++ (if (platform.config.contribs.brave.apiKeySecret.name or "") == "brave-search-key" then [ ] else
    [ "contribs.brave.apiKeySecret did not take the example's value — a contrib's own options are not reaching the platform eval (modules/platform.nix imports the declarations via contrib/all-modules.nix and their deployment halves beside them), so every check below passes for the wrong reason" ])
    ++ (if platform.config.contribs ? aws then [ ] else
    [ "config.contribs.aws is missing — the contrib DECLARATIONS are not in the platform eval, so contrib skills are read from an empty set" ])
    ++ (if echoSkillsRender then [ ] else
    [ "a DISABLED contrib declaring a skill broke the render — platform.nix reads skills off every contrib in the eval instead of only the ones `enable` ships, so it looked for a gate option an unshipped contrib has no reason to declare" ])
    ++ (if echoSkillsRender && builtins.elem echoSkillFile echoSkills then
    [ "a DISABLED contrib's skill SHIPPED — an image that never built the contrib carries instructions for routes it does not serve" ] else [ ])
    # The example configures brave, so unshipping it is the mistake shipGate catches.
    ++ (if renders { contribs.brave.enable = nixpkgsLib.mkForce false; }
        then [ "a render configuring brave succeeded with brave UNSHIPPED (contribs.brave.enable = false) — shipGate is a no-op, so an operator gets a broker with no brave provider, an agent with no brave_web_search, and no error (#599)" ]
        else [ ])
    # duckduckgo has no deployment options; unshipping stays legal.
    ++ (if renders { contribs.duckduckgo.enable = nixpkgsLib.mkForce false; } then [ ]
        else [ "dropping a contrib the example never configures stopped the render — shipGate fires on `enable = false` alone instead of on the unshipped-AND-configured pair, so no deployment can trim the contrib set" ]);

  legacyRootProblems =
    (if renders { } then [ ]
     else [ "the example stopped rendering through the legacy-root harness (the check is broken, not the example)" ])
    ++ (if renders { agentSandbox.broker.enable = true; }
        then [ "a config on the OLD root (agentSandbox.*) still rendered — the #710 guard is a no-op, so that deployment silently gets every option at its default" ]
        else [ ]);

  # The router stamps spec.owner on create, so it needs the agent-host's identity
  # config plus the SA allowlist and TokenReview grant that let webhooks/scheduler
  # pass a resolved owner.
  routerEnv =
    let ctrs = builtins.attrValues (res.deployments.conversation-router.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  routerEnvVal = name: let m = builtins.filter (e: e.name == name) routerEnv; in if m == [ ] then "" else (builtins.head m).value;
  albPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.auth.mode = lib.mkForce "alb-oidc";
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

  # The shared broker database reaches the broker regardless of which feature wants
  # it: present with aws off, and never declared twice with aws on.
  awsOffPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      # mkForce the attr so the config goes with it.
      contribs.aws = lib.mkForce { enable = false; };
      scooter.broker.shares.enable = lib.mkForce false;
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

  # No env name may be declared twice on the broker container, since k8s silently
  # keeps the last value (deduplicated via a set because this file has no `lib`).
  brokerEnvNames = builtins.attrNames
    (builtins.listToAttrs (map (e: { name = e.name; value = null; }) brokerEnv));
  dupEnvProblems = map
    (n: "broker.env.${n} declared more than once (k8s keeps the LAST value silently — a contrib's broker.extraEnv must not reuse a core name)")
    (builtins.filter (n: countNamed brokerEnv n > 1) brokerEnvNames);

  # A contrib's platform module reaches the broker deployment through every seam
  # (env, volume + mount, annotation, its own resource), and with aws off none of it
  # reaches the pod.
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
        else [ "configMaps.agent-broker-aws-accounts missing — a contrib's platform module cannot render its own resources" ])
    ++ (if builtins.all (c: !(hasName (c.volumeMounts or [ ]) "aws-accounts")) awsOffCtrs then [ ]
        else [ "aws-off: broker still mounts aws-accounts — the seam is wired unconditionally, so the pod mounts a ConfigMap that is not rendered" ])
    ++ (if builtins.all (c: countNamed (c.env or [ ]) "AWS_ENABLED" == 0) awsOffCtrs then [ ]
        else [ "aws-off: broker.env.AWS_ENABLED present — contrib env is not gated on the contrib's own enable" ]);

  # A contrib's platform module reaches the sandbox pod through the manifest-overlay
  # ConfigMap, and with aws off none of it does (an unsatisfiable volume would leave
  # every sandbox Pending).
  contribOverlayOf = e:
    let cms = e.config.kubernetes.resources.configMaps or { };
        cm = cms.sandbox-manifest-overlay or null;
    in if cm == null || !(cm.data ? "contrib.yaml") then null
       else (builtins.fromJSON cm.data."contrib.yaml").spec.podTemplate.spec;
  contribPodSpec = contribOverlayOf platform;
  # The overlay keys on the container named `sandbox`, or the patch merges onto nothing.
  contribCtr =
    if contribPodSpec == null then null
    else let m = builtins.filter (c: c.name == "sandbox") contribPodSpec.containers; in
      if m == [ ] then null else builtins.head m;
  sandboxSeamProblems =
    (if contribPodSpec != null then [ ]
     else [ ("configMaps.sandbox-manifest-overlay has no contrib.yaml — contrib/aws/deployment.nix"
             + " did not reach the sandbox pod through scooter.sandboxPod, so no sandbox"
             + " renders ~/.aws/config and `scooter-aws` has no profiles") ])
    ++ (if contribPodSpec == null || contribCtr != null then [ ]
        else [ "contrib.yaml patches no container named `sandbox` — it would merge onto nothing" ])
    ++ (if contribCtr == null || hasName (contribCtr.volumeMounts or [ ]) "aws-accounts" then [ ]
        else [ "sandboxPod.extraVolumeMounts aws-accounts missing — the sandbox has no account registry to read" ])
    ++ (if contribPodSpec == null || hasName (contribPodSpec.volumes or [ ]) "aws-accounts" then [ ]
        else [ "sandboxPod.extraVolumes aws-accounts missing — the mount above has no source, so every sandbox pod stays Pending" ])
    ++ (if contribCtr == null || hasName (contribCtr.env or [ ]) "AWS_ACCOUNTS_FILE" then [ ]
        else [ "sandboxPod.extraEnv AWS_ACCOUNTS_FILE missing — the mount is there but nothing tells the sandbox where it is" ])
    ++ (if contribOverlayOf awsOffPlatform == null then [ ]
        else [ ("aws-off: sandbox-manifest-overlay still carries contrib.yaml — the sandbox seam is"
                + " wired unconditionally, so every sandbox mounts a ConfigMap that is not rendered") ]);

  # Sandbox self-access: the router serves the listener, a Service fronts it, and every sandbox
  # gets the token audience and the URL to reach it.
  routerPorts =
    let ctrs = builtins.attrValues (res.deployments.conversation-router.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.ports or [ ]) ctrs;
  hostEnvVal = name: let m = builtins.filter (e: e.name == name) hostEnv; in if m == [ ] then "" else (builtins.head m).value;
  selfAccessProblems =
    (if hasName routerEnv "SELF_LISTEN_ADDR" then [ ] else [ "router.env.SELF_LISTEN_ADDR (selfAccess.enable not wired into the router)" ])
    ++ (if hasName routerPorts "self" then [ ] else [ "router port `self` missing — the Service below has nothing to target" ])
    ++ (if (res.services or { }) ? conversation-router-self then [ ] else [ "services.conversation-router-self missing" ])
    ++ (if builtins.elem "scooter-self" (builtins.filter builtins.isString (builtins.split "," (hostEnvVal "SCOOTER_TOKEN_AUDIENCES"))) then [ ]
        else [ "host.env.SCOOTER_TOKEN_AUDIENCES lacks scooter-self — sandboxes get no token for the listener" ])
    ++ (if (builtins.fromJSON (if hostEnvVal "SCOOTER_ENV" == "" then "{}" else hostEnvVal "SCOOTER_ENV")) ? SCOOTER_SELF_URL then [ ]
        else [ "host.env.SCOOTER_ENV lacks SCOOTER_SELF_URL — the sandbox cannot find the listener" ]);

  # A contrib's approval declaration reaches the agent-host, and with aws off it does not.
  approvalsJson =
    let m = builtins.filter (e: e.name == "APPROVAL_CONTRIBS_JSON") hostEnv;
    in if m == [ ] then null else builtins.fromJSON (builtins.head m).value;
  awsOffApprovals =
    let ctrs = builtins.attrValues (awsOffPlatform.config.kubernetes.resources.deployments.agent-host.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  approvalProblems =
    (if approvalsJson != null then [ ]
     else [ ("host.env.APPROVAL_CONTRIBS_JSON missing — aws declares approvals but the"
             + " agent-host has no route to relay an answer to, so every Approve click"
             + " is recorded nowhere") ])
    ++ (if approvalsJson == null || approvalsJson ? aws then [ ]
        else [ "APPROVAL_CONTRIBS_JSON has no aws row (contrib/aws/default.nix declares one)" ])
    ++ (if approvalsJson == null || (approvalsJson.aws.brokerPrefix or "") == "/aws/aws" then [ ]
        else [ "aws.brokerPrefix must be /aws/aws — the core mounts a provider at /{name} and the transport adds its own prefix" ])
    ++ (if approvalsJson == null || (approvalsJson.aws.pendingPath or null) != null then [ ]
        else [ ("aws.pendingPath is null — an approval window lost to a pod rollout would"
                + " never be re-raised, leaving a blocked agent and a user with nothing to click") ])
    ++ (if builtins.all (e: e.name != "APPROVAL_CONTRIBS_JSON") awsOffApprovals then [ ]
        else [ "aws-off: host.env.APPROVAL_CONTRIBS_JSON present — approvals are not gated on the contrib's own enable" ]);

  # `permission_requests` is declared whenever aws is built, even with the broker off.
  brokerOffPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.broker.enable = lib.mkForce false;
    };
  };
  brokerOffTables = brokerOffPlatform.config.scooter.db.broker.tables or { };
  stage2Problems =
    (if brokerOffTables ? permission_requests then [ ]
     else [ ("broker-off: scooter.db.broker.tables.permission_requests missing —"
             + " a contrib's table declaration is gated on the DEPLOYMENT running it,"
             + " so `just db-generate` drops the table and the migration history no"
             + " longer describes this tree") ])
    ++ (if (brokerOffTables.permission_requests.writers or [ ]) == [ "broker" ] then [ ]
        else [ "permission_requests.writers should be [\"broker\"] (the contrib writes through the broker's role)" ])
    # Negative half: unshipping aws drops the table.
    ++ (if (awsOffPlatform.config.scooter.db.broker.tables or { }) ? permission_requests
        then [ ("aws-off: permission_requests is declared with aws UNSHIPPED — the"
                + " table declaration is not gated on the contrib being built, so the"
                + " schema describes a writer no image contains") ] else [ ]);

  # aws owns a database (contribs.aws.db): created on the broker's role, migrated as
  # that role, its rows copied out of `broker` once, and named on the broker pod.
  migrateEnv = res.jobs.agent-db-migrate.spec.template.spec.containers.migrate.env;
  contribEnvValue = l: n: let m = builtins.filter (e: e.name == n) l; in if m == [ ] then null else (builtins.head m).value;
  initScript = let c = res.jobs.agent-postgres-init.spec.template.spec.containers.sql.command; in
    builtins.elemAt c (builtins.length c - 1);
  hasWord = w: s: builtins.elem w (builtins.filter builtins.isString (builtins.split "[ \n]+" s));
  contribDbProblems =
    (if hasWord "contrib_aws:broker" (toString (contribEnvValue migrateEnv "DB_ENVS")) then [ ]
     else [ "migrate.env.DB_ENVS lacks contrib_aws:broker — aws's own database is never migrated, or not as the broker's role" ])
    ++ (if hasWord "contrib_aws:permission_requests:broker" (toString (contribEnvValue migrateEnv "DB_COPIES")) then [ ]
        else [ "migrate.env.DB_COPIES lacks contrib_aws:permission_requests:broker — the old rows would be left behind in broker" ])
    ++ (if builtins.match ''.*CREATE DATABASE "contrib_aws" OWNER "broker".*'' initScript != null then [ ]
        else [ "agent-postgres-init does not create contrib_aws owned by broker" ])
    ++ (if builtins.match ".*agent-pg-contrib.*" initScript == null then [ ]
        else [ "agent-postgres-init mints a per-contrib Secret — roles stay per service, and a second Secret for broker would reset its password" ])
    ++ (if contribEnvValue brokerEnv "CONTRIB_AWS_DB_NAME" == "contrib_aws" then [ ]
        else [ "broker.env.CONTRIB_AWS_DB_NAME != contrib_aws — the store would connect to the wrong database" ])
    ++ (if (platform.config.scooter.db.contrib_aws.sqlDir or null) == "contrib/aws/sql" then [ ]
        else [ "scooter.db.contrib_aws.sqlDir != contrib/aws/sql — its migrations would be looked for in lib/sql" ])
    # Unshipping aws drops its database entirely.
    ++ (if (awsOffPlatform.config.scooter.db or { }) ? contrib_aws
        then [ "aws-off: scooter.db.contrib_aws still declared — a database for a contrib no image contains" ] else [ ]);

  # The broker tables are dropped only on a deployment that opts in.
  retirePlatform = evalPlatform {
    module = { ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.dbMigrate.retireCopiedTables = true;
    };
  };
  retireEnv = retirePlatform.config.kubernetes.resources.jobs.agent-db-migrate.spec.template.spec.containers.migrate.env;
  retireProblems =
    (if contribEnvValue migrateEnv "DB_RETIRE_COPIED" == null then [ ]
     else [ "migrate.env.DB_RETIRE_COPIED is set by default — every deployment would drop the broker tables on upgrade" ])
    ++ (if contribEnvValue retireEnv "DB_RETIRE_COPIED" == "1" then [ ]
        else [ "dbMigrate.retireCopiedTables = true does not set migrate.env.DB_RETIRE_COPIED — the tables would never be dropped" ]);

  # `broker.fga` is a core option, so the render proving it is fga on with aws off.
  fgaNoAwsPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      # mkForce the attr so the config goes with it.
      contribs.aws = lib.mkForce { enable = false; };
      scooter.broker.fga.enable = true;
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
    ++ (if (fgaNoAwsPlatform.config.scooter.postgres.consumers or { }) ? openfga then [ ]
        else [ "fga-without-aws: postgres.consumers.openfga missing — openfga has no database or role" ]);

  # The approver allowlist belongs to core auth and shares reads it too, so with aws
  # off and shares on the env must be present and name the agent-host (an empty
  # value authenticates nobody).
  sharesNoAwsPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      # mkForce the attr so the config goes with it.
      contribs.aws = lib.mkForce { enable = false; };
      # shares.enable stays true from the example.
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

  # Every container carrying a `<prefix>DB_HOST` must also carry `<prefix>DB_SSLMODE`
  # once the deployment sets one, derived from what each workload emits; this needs a
  # non-cluster render because in-cluster leaves sslmode null.
  tlsPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.postgres.external = {
        host = "pg.example.invalid";
        sslmode = "require";
        user = "postgres";
        passwordSecret = { name = "pg-admin"; key = "password"; };
      };
    };
  };
  tlsRes = tlsPlatform.config.kubernetes.resources;
  # Every container of every workload kind.
  # Per-conversation service origins: with ingress.sandboxDomain set, a wildcard Ingress
  # goes straight to the router, and the router and agent-host both learn the domain.
  sandboxRes = (evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.ingress.sandboxDomain = "sandbox.example.com";
      scooter.ingress.sandboxTlsSecretName = "sandbox-wildcard-tls";
    };
  }).config.kubernetes.resources;
  envIn = dep: name:
    let env = builtins.concatMap (c: c.env or [ ])
          (builtins.attrValues (sandboxRes.deployments.${dep}.spec.template.spec.containers or { }));
        m = builtins.filter (e: e.name == name) env;
    in if m == [ ] then null else (builtins.head m).value;
  sbIngress = sandboxRes.ingresses.sandbox-services or null;
  sandboxOriginProblems =
    (if (res.ingresses or { }) ? sandbox-services then
    [ "the sandbox-services Ingress renders with no ingress.sandboxDomain" ] else [ ])
    ++ (if sbIngress == null then
    [ "ingress.sandboxDomain set but no sandbox-services Ingress rendered" ]
    else
      let rule = builtins.head sbIngress.spec.rules; in
      (if rule.host != "*.sandbox.example.com" then [ "sandbox-services Ingress host is ${rule.host}, not *.sandbox.example.com" ] else [ ])
      ++ (let b = (builtins.head rule.http.paths).backend.service; in
          if b.name != "agent-host" || (b.port.name or "") != "sandbox" then
          [ "sandbox-services Ingress must go to the router's sandbox listener (agent-host Service, port `sandbox`); any other port exposes the router's API on the wildcard host" ] else [ ])
      ++ (if !(builtins.any (p: p.name == "sandbox" && p.targetPort == "sandbox") (sandboxRes.services.agent-host.spec.ports or [ ])) then
          [ "the agent-host Service has no `sandbox` port for the wildcard Ingress" ] else [ ])
      ++ (if builtins.any (p: p.name == "sandbox") (res.services.agent-host.spec.ports or [ ]) then
          [ "the agent-host Service exposes a `sandbox` port with no ingress.sandboxDomain" ] else [ ])
      ++ (if (builtins.head (sbIngress.spec.tls or [ { } ])).secretName or "" != "sandbox-wildcard-tls" then
          [ "sandbox-services Ingress does not use sandboxTlsSecretName" ] else [ ]))
    ++ (if envIn "conversation-router" "SANDBOX_LISTEN_ADDR" != ":8082" then
    [ "the conversation-router does not get SANDBOX_LISTEN_ADDR, so its sandbox listener is not the port the Service targets" ] else [ ])
    ++ (if envIn "conversation-router" "SANDBOX_DOMAIN" != "sandbox.example.com" then
    [ "the conversation-router does not get SANDBOX_DOMAIN, so it never routes sandbox hosts" ] else [ ])
    ++ (if envIn "agent-host" "SANDBOX_DOMAIN" != "sandbox.example.com" then
    [ "the agent-host does not get SANDBOX_DOMAIN, so sandboxes never learn their origin" ] else [ ])
    ++ (if envIn "ui" "SANDBOX_DOMAIN" != "sandbox.example.com" then
    [ "the ui does not get SANDBOX_DOMAIN, so no sandbox can frame its own /chat/<id>" ] else [ ]);
  allWorkloads = builtins.concatMap
    (kind: builtins.attrValues (tlsRes.${kind} or { }))
    [ "deployments" "statefulSets" "jobs" "cronJobs" ];
  containersOf = w:
    let spec = w.spec.template.spec or (w.spec.jobTemplate.spec.template.spec or { });
    in builtins.attrValues (spec.containers or { });
  # "AGENT_HOST_DB_HOST" -> "AGENT_HOST_DB_", "DB_HOST" -> "DB_"
  prefixOf = name: builtins.substring 0 (builtins.stringLength name - 4) name;
  # A derived check can pass by scanning nothing, so fail if the examined count collapses.
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

  # Contrib settings tabs, resolved by the same function the UI manifest uses, over
  # the platform eval's contribs with fixture overrides. Echo declares a tab and is
  # disabled; each bad declaration must throw, since a tab the UI cannot route is
  # otherwise a silently broken page.
  resolveSettingsTabs = import ../contrib/settings-tabs.nix { lib = nixpkgsLib; };
  tabsWith = extra:
    let
      e = evalPlatform {
        module = { ... }: {
          imports = [ ./kubenix-config.nix ];
          config = extra;
        };
      };
    in resolveSettingsTabs (nixpkgsLib.filterAttrs (_: c: c.enable) e.config.contribs);
  tabsThrow = extra: !(builtins.tryEval (builtins.deepSeq (tabsWith extra) true)).success;
  echoOn = tabs: {
    contribs.echo.enable = nixpkgsLib.mkForce true;
    contribs.echo.ui.settingsTabs = nixpkgsLib.mkForce tabs;
  };
  echoTab = { label = "Echo"; entry = "ui/SettingsTab.tsx"; };
  settingsTabProblems =
    (if (tabsWith { }) ? echo
     then [ "the echo settings tab is in the manifest while echo is disabled — tabs are not gated on the contrib's `enable`" ] else [ ])
    ++ (if ((tabsWith { contribs.echo.enable = nixpkgsLib.mkForce true; }).echo.entry or null) == "echo/ui/SettingsTab.tsx" then [ ]
        else [ "enabling echo did not put its settings tab in the manifest as id `echo` with entry echo/ui/SettingsTab.tsx" ])
    ++ (if tabsThrow (echoOn [ (echoTab // { id = "other"; }) ]) then [ ]
        else [ "a settings tab id outside `<contrib>[-…]` rendered — tab URLs are no longer scoped by contrib" ])
    ++ (if tabsThrow (echoOn [ echoTab echoTab ]) then [ ]
        else [ "two settings tabs with the same id rendered — one silently replaces the other in the manifest" ])
    ++ (if tabsThrow (echoOn [ (echoTab // { entry = "ui/Missing.tsx"; }) ]) then [ ]
        else [ "a settings tab whose entry does not exist rendered — the UI would show an error card instead of failing the eval" ])
    ++ (if tabsThrow (echoOn [ (echoTab // { id = "echo_Bad"; }) ]) then [ ]
        else [ "a settings tab id that is not a URL slug rendered" ]);

  allProblems = disabledContribProblems ++ settingsTabProblems ++ dirSkillProblems ++ legacyRootProblems ++ searchProblems ++ oneEntrypointProblems ++ ownerProblems ++ jobImmutabilityProblems ++ sizeGuardProblems ++ skillProblems ++ problems ++ ddProblems ++ atProblems ++ sharesProblems ++ cfProblems ++ csProblems ++ dbProblems ++ puProblems ++ mdProblems ++ ngProblems ++ rolloutProblems ++ testProblems ++ schedProblems ++ otelProblems ++ coverageProblems ++ contribCoverageProblems ++ brokerDbProblems ++ dupEnvProblems ++ contribSeamProblems ++ sandboxSeamProblems ++ approvalProblems ++ stage2Problems ++ contribDbProblems ++ retireProblems ++ fgaProblems ++ sslProblems ++ vacuityProblems ++ approverProblems ++ selfAccessProblems ++ sandboxOriginProblems;
in
if allProblems == [ ]
then "ok: deployments = ${haveDeps}; datadog + airtable + brave + kagi + duckduckgo (three search providers, each with its own tool) + configFiles + broker config-rollout + models + scheduler + otel wired; example covers every scooter.* namespace and every shipped contrib's own options; skills gated on the contrib being built; sandbox-shaping env is agent-host-only (one provisioning entrypoint); sandbox size default guard fires on 0 and 2 defaults; the renamed root (agentSandbox.*) fails the render; contribs reach the platform eval and configuring an unshipped one fails the render; deploy-time Jobs are spec-hash named\n"
else builtins.throw "example manifests missing: ${builtins.concatStringsSep ", " allProblems}"
