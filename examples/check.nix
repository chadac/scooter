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

  # Same for google.
  googleProblems = if builtins.any (e: e.name == "GOOGLE_SERVICE_ACCOUNT_JSON") brokerEnv then [ ]
    else [ "broker.env.GOOGLE_SERVICE_ACCOUNT_JSON (google provider not wired)" ];

  # GitHub owners reach both the broker and webhooks.
  ghOwnersProblems =
    let
      webhooksEnv = builtins.concatMap (c: c.env or [ ])
        (builtins.attrValues (res.deployments.agent-webhooks.spec.template.spec.containers or { }));
      owners = env: map (e: e.value or "") (builtins.filter (e: e.name == "GITHUB_APP_OWNERS") env);
    in
    (if owners brokerEnv == [ "my-user,my-org" ] then [ ] else [ "broker.env.GITHUB_APP_OWNERS is not my-user,my-org" ])
    ++ (if owners webhooksEnv == [ "my-user,my-org" ] then [ ] else [ "webhooks.env.GITHUB_APP_OWNERS is not my-user,my-org" ])
    ++ (if builtins.any (e: e.name == "GITHUB_APP_INSTALLATION_ID" && (e.value or "") == "") brokerEnv
        then [ "broker.env.GITHUB_APP_INSTALLATION_ID renders empty, which fails the int parse" ] else [ ]);

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

  # Static shares: the broker must carry a public base URL derived from ingress.host.
  sharesEnvVal = name: let m = builtins.filter (e: e.name == name) brokerEnv; in if m == [ ] then "" else (builtins.head m).value;
  sharesProblems =
    (if builtins.match "https://.+" (sharesEnvVal "SHARES_PUBLIC_BASE_URL") != null then [ ]
        else [ "broker.env.SHARES_PUBLIC_BASE_URL (should derive from ingress.host)" ])
    ++ map (t: "migrate.env.DB_COPIES lacks contrib_shares:${t}:broker — published shares would be left behind in broker")
      (builtins.filter (t: !hasWord "contrib_shares:${t}:broker" (toString (contribEnvValue migrateEnv "DB_COPIES")))
        [ "static_shares" "static_share_versions" ])
    ++ (if contribEnvValue legacySharesEnv "SHARES_PUBLIC_BASE_URL" == "https://legacy.example.com" then [ ]
        else [ "scooter.broker.shares.* no longer reaches contribs.shares — an existing deployment's config is dropped" ])
    ++ (if brokerPathsAt res == [ ] then [ ]
        else [ "ingress routes /s/ to the broker with the UI on — the UI's nginx proxies it" ])
    ++ (if brokerPathsAt (uiOffRes { }) == [ "/s/" ] then [ ]
        else [ "ui-off: the Ingress lacks /s/ -> agent-broker, so share links 404" ])
    ++ (if brokerPathsAt (uiOffRes ({ lib, ... }: { contribs.shares.enable = lib.mkForce false; })) == [ ] then [ ]
        else [ "ui-off, shares disabled: the Ingress still routes /s/ to the broker" ]);
  # The main Ingress's paths that go to the broker.
  brokerPathsAt = r: map (p: p.path) (builtins.filter (p: p.backend.service.name == "agent-broker")
    (builtins.concatMap (rule: rule.http.paths) r.ingresses.agent-host.spec.rules));
  uiOffRes = extra: (evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix extra ];
      scooter.ui.enable = lib.mkForce false;
    };
  }).config.kubernetes.resources;
  # The pre-contrib option path still configures the contrib.
  legacySharesEnv = deployEnv (evalPlatform {
    module = { ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.broker.shares.publicBaseUrl = "https://legacy.example.com";
    };
  }).config.kubernetes.resources "agent-broker";

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
    "SANDBOX_IMAGE" "SANDBOX_PULL_POLICY" "SANDBOX_RUNTIME_CLASS" "SANDBOX_VOLUME_CLAIMS" "SANDBOX_RESOURCES"
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
        else [ "no-goose: AGENT_MODELS_JSON claude-opus-5 should be default:true" ])
    ++ (if ngOpus != [ ] && (builtins.head ngOpus).priorities == { byoc = 100; claude-code = 100; } then [ ]
        else [ "no-goose: `default = true` should render as priority 100 per provider" ]);

  # Equal top priorities both render as defaults, so the agent-host samples between them.
  tiePlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.fakeAgent = lib.mkForce false;
      scooter.agent.availableModels = lib.mkForce {
        "claude-code"."claude-opus-5" = { priority = 50; };
        "claude-code"."claude-fable-5" = { priority = 50; };
        "claude-code"."claude-haiku-5" = { };
      };
    };
  };
  tieModels =
    let ctrs = builtins.attrValues (tiePlatform.config.kubernetes.resources.deployments.agent-host.spec.template.spec.containers or { });
        env = builtins.filter (e: e.name == "AGENT_MODELS_JSON") (builtins.concatMap (c: c.env or [ ]) ctrs);
    in if env == [ ] then [ ] else builtins.fromJSON (builtins.head env).value;
  tieDefaults = map (m: m.id) (builtins.filter (m: m.defaultFor == [ "claude-code" ]) tieModels);
  ngProblems' = ngProblems
    ++ (if tieDefaults == [ "claude-fable-5" "claude-opus-5" ] then [ ]
        else [ "priority tie: both priority-50 models should be claude-code defaults, got ${builtins.toJSON tieDefaults}" ]);

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
  # path, deployment-specific image/identity/runtime knobs (incl. the cluster-dependent
  # sandboxUserNamespace, which needs Kubernetes >= 1.33), readOnly derived options
  # (defaultSandboxSizeName, dbSpec), and the contrib seams (db, sandboxPod,
  # approvals) that the seam checks below cover more strongly.
  coverageExempt = [
    "conversationController" "postgres" "legacyStateMigration"
    "sandboxRuntimeClass" "sandboxUserNamespace" "workspaceStorageClass" "serviceAccountRoleArn"
    "agentHostImage" "sandboxImage" "uiImage" "defaultSandboxSizeName"
    "db" "dbSpec" "sandboxPod" "approvals"
    # internal output of modules/contrib-db.nix, not a deployer setting
    "contribDbEnv"
    # declared per-service module; a deployer overrides a ref, not the tree
    "images" "imagesContentTag"
    # the build itself; set only to patch a package
    "packages" "config"
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
    # Owner-asserting callers' tokens must pass both owner checks.
    ++ builtins.concatMap (dep:
        let
          vols = res.deployments.${dep}.spec.template.spec.volumes or [ ];
          auds = builtins.concatMap (v: map (s: s.serviceAccountToken.audience or "") (v.projected.sources or [ ]))
            (builtins.filter (v: v.name == "agent-host-token") vols);
          hostEnv = builtins.concatMap (c: c.env or [ ])
            (builtins.attrValues (res.deployments.agent-host.spec.template.spec.containers or { }));
          hostAuds = nixpkgsLib.splitString "," (let m = builtins.filter (e: e.name == "WEBHOOKS_TOKEN_AUDIENCE") hostEnv;
            in if m == [ ] then "agent-host" else (builtins.head m).value);
          routerAuds = [ (routerEnvVal "WEBHOOKS_TOKEN_AUDIENCE") (routerEnvVal "ROUTER_TOKEN_AUDIENCE") ];
        in if !(res.deployments ? ${dep}) then [ ]
           else if auds == [ ] then [ "${dep}: no agent-host-token volume (owners are dropped)" ]
           else builtins.concatMap (a:
             nixpkgsLib.optional (!(builtins.elem a hostAuds)) "${dep}: token audience ${a} not accepted by agent-host WEBHOOKS_TOKEN_AUDIENCE"
             ++ nixpkgsLib.optional (!(builtins.elem a routerAuds)) "${dep}: token audience ${a} not accepted by the router's owner check") auds)
      [ "agent-webhooks" "agent-scheduler" ]
    # The gateway must admit the broker's router calls.
    ++ (if builtins.match ".*:agent-broker" (routerEnvVal "ROUTER_SERVICE_ACCOUNTS") != null then [ ]
        else [ "router.env.ROUTER_SERVICE_ACCOUNTS omits the broker SA (its /links calls look unauthenticated)" ])
    ++ (if builtins.any (v: v.name == "scooter-router-token"
            && builtins.any (s: (s.serviceAccountToken.audience or "") == routerEnvVal "ROUTER_TOKEN_AUDIENCE") (v.projected.sources or [ ]))
          (res.deployments.agent-broker.spec.template.spec.volumes or [ ]) then [ ]
        else [ "broker.volumes scooter-router-token must be minted for ROUTER_TOKEN_AUDIENCE" ])
    ++ (if (res.clusterRoleBindings or { }) ? conversation-router-tokenreview then [ ]
        else [ "clusterRoleBindings.conversation-router-tokenreview (TokenReview 403s, so every webhook conversation is unowned)" ])
    ++ (if builtins.any (e: e.name == "AUTH_MODE" && e.value == "alb-oidc") albRouterEnv then [ ]
        else [ "alb-oidc: router.env.AUTH_MODE (the router reads x-auth-user, which an ALB never sets — every caller looks anonymous and sees every conversation)" ]);

  # Enforcement needs a session check, else every browser request is refused.
  enforcePlatform = evalPlatform {
    module = { ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.auth = {
        enforce = true;
        sessionCheckUrl = "http://oauth2-proxy.example.svc.cluster.local/oauth2/auth";
        emailHeader = "x-forwarded-email";
      };
    };
  };
  enforceRouterEnv =
    let ctrs = builtins.attrValues (enforcePlatform.config.kubernetes.resources.deployments.conversation-router.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  enforceHostEnv =
    let ctrs = builtins.attrValues (enforcePlatform.config.kubernetes.resources.deployments.agent-host.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  enforceProblems =
    (if renders { scooter.auth.enforce = true; }
     then [ "auth.enforce rendered without sessionCheckUrl: the router would refuse every browser request" ]
     else [ ])
    ++ (if builtins.elem { name = "AUTH_ENFORCE"; value = "true"; } enforceRouterEnv then [ ]
        else [ "auth.enforce did not reach router.env.AUTH_ENFORCE" ])
    ++ (if builtins.elem { name = "AUTH_ENFORCE"; value = "true"; } enforceHostEnv then [ ]
        else [ "auth.enforce did not reach agent-host.env.AUTH_ENFORCE: anonymous callers could change any conversation" ])
    ++ (if builtins.any (e: e.name == "AUTH_ENFORCE") hostEnv
        then [ "the example tells agent-host to enforce auth without opting in" ] else [ ])
    ++ (if builtins.elem { name = "AUTH_EMAIL_HEADER"; value = "x-forwarded-email"; } enforceRouterEnv then [ ]
        else [ "router.env.AUTH_EMAIL_HEADER missing: an enforcing router would leave a client-sent email header in place" ])
    ++ (if builtins.any (e: e.name == "AUTH_ENFORCE") routerEnv
        then [ "the example enforces auth without opting in" ] else [ ]);

  # The shared broker database reaches the broker regardless of which feature wants
  # it: present with aws off, and never declared twice with aws on.
  awsOffPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      # mkForce the attr so the config goes with it.
      contribs.aws = lib.mkForce { enable = false; };
      contribs.shares = lib.mkForce { enable = false; };
      contribs.ssh = lib.mkForce { enable = false; };
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
  # ConfigMap, and with aws off none of aws's does (an unsatisfiable volume would leave
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
    ++ (let off = contribOverlayOf awsOffPlatform; in
        if off == null || !(hasName (off.volumes or [ ]) "aws-accounts") then [ ]
        else [ ("aws-off: sandbox-manifest-overlay still mounts aws-accounts — the sandbox seam is"
                + " wired unconditionally, so every sandbox mounts a ConfigMap that is not rendered") ])
    # The forge proxy is always on: every sandbox trusts the forge CA (optional, so pods start
    # before the broker first publishes it) and sends HTTPS through the in-pod shim.
    ++ (if contribPodSpec != null && builtins.any (v: v.name == "forge-ca" && (v.configMap.optional or false)) (contribPodSpec.volumes or [ ]) then [ ]
        else [ "sandboxPod.extraVolumes forge-ca (optional ConfigMap scooter-forge-ca) missing — no sandbox trusts the forge CA" ])
    ++ (if contribCtr != null && hasName (contribCtr.env or [ ]) "HTTPS_PROXY" && hasName (contribCtr.env or [ ]) "FORGE_PROXY_ADDR" then [ ]
        else [ "sandboxPod.extraEnv HTTPS_PROXY / FORGE_PROXY_ADDR missing — sandbox git/gh/glab bypass the forge proxy" ])
    ++ (if contribCtr != null && hasName (contribCtr.env or [ ]) "SSH_AUTH_SOCK" then [ ]
        else [ "sandboxPod.extraEnv SSH_AUTH_SOCK missing with ssh on — sandbox ssh never reaches the broker-backed agent" ])
    ++ (let off = contribOverlayOf awsOffPlatform;
            ctrs = if off == null then [ ] else builtins.filter (c: c.name == "sandbox") off.containers;
        in if !(builtins.any (c: hasName (c.env or [ ]) "SSH_AUTH_SOCK") ctrs) then [ ]
        else [ "ssh-off: sandboxPod.extraEnv still sets SSH_AUTH_SOCK — contrib/ssh/deployment.nix is not gated on the contrib" ]);

  # scooter.sandbox.volumes reaches the provisioner as SANDBOX_VOLUME_CLAIMS: defaults keep the
  # overlay claim on the warm pool, an override and the renamed workspaceStorageClass land on
  # the workspace claim, and an overlay class off the pool fails the render.
  claimsOf = e: builtins.fromJSON (builtins.head (builtins.filter (x: x.name == "SANDBOX_VOLUME_CLAIMS")
    e.config.kubernetes.resources.deployments.agent-host.spec.template.spec.containers.agent-host.env)).value;
  withVolumes = m: evalPlatform { module = { imports = [ ./kubenix-config.nix m ]; }; };
  defaultClaims = claimsOf platform;
  setClaims = claimsOf (withVolumes {
    scooter.sandbox.volumes.workspace = { spec.storageClassName = "gp3"; metadata.labels.tier = "fast"; };
  });
  legacyClaims = claimsOf (withVolumes { scooter.workspaceStorageClass = "legacy"; });
  offPool = builtins.tryEval (builtins.deepSeq
    (claimsOf (withVolumes { scooter.sandbox.volumes.overlay.spec.storageClassName = "elsewhere"; })) true);
  volumeProblems =
    (if defaultClaims.workspace or null == { metadata.name = "workspace"; spec = { accessModes = [ "ReadWriteOnce" ]; resources.requests.storage = "10Gi"; }; }
     then [ ] else [ "SANDBOX_VOLUME_CLAIMS.workspace is not the 10Gi RWO default" ])
    ++ (if (defaultClaims.scooter-rw.spec.storageClassName or null) == platform.config.scooter.warmStore.storageClass
        then [ ] else [ "SANDBOX_VOLUME_CLAIMS.scooter-rw is off the warm-store pool class" ])
    ++ (if setClaims.workspace.spec.storageClassName or null == "gp3" && setClaims.workspace.metadata.labels.tier or null == "fast"
          && setClaims.workspace.spec.resources.requests.storage or null == "10Gi"
        then [ ] else [ "scooter.sandbox.volumes.workspace did not merge onto the default claim" ])
    ++ (if legacyClaims.workspace.spec.storageClassName or null == "legacy" then [ ]
        else [ "scooter.workspaceStorageClass no longer reaches the workspace claim" ])
    ++ (if !offPool.success then [ ]
        else [ "an overlay claim class off the warm-store pool rendered instead of failing" ]);

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

  # Sandbox isolation renders by default, admits only the SA-token surfaces, and turns off.
  sandboxNp = (res.networkPolicies or { }).sandbox-isolation or null;
  npEgress = if sandboxNp == null then [ ] else sandboxNp.spec.egress;
  npPeerApps = rule: map (p: p.podSelector.matchLabels.app or null) (rule.to or [ ]);
  npPortsTo = app: builtins.concatMap (r: if builtins.elem app (npPeerApps r) then map (p: p.port) (r.ports or [ ]) else [ ]) npEgress;
  ctrPortNames = dep: builtins.concatMap (c: map (p: p.name or "") (c.ports or [ ]))
    (builtins.attrValues (res.deployments.${dep}.spec.template.spec.containers or { }));
  npInternet = builtins.concatMap (r: builtins.filter (p: p ? ipBlock) (r.to or [ ])) npEgress;
  npProblems =
    if sandboxNp == null then [ "networkPolicies.sandbox-isolation missing (networkPolicy.enable defaults to true)" ] else
    (if sandboxNp.spec.podSelector.matchExpressions or [ ] == [ { key = "agents.x-k8s.io/sandbox-name-hash"; operator = "Exists"; } ] then [ ]
     else [ "sandbox-isolation does not select sandbox pods by agents.x-k8s.io/sandbox-name-hash (the controller strips the template label)" ])
    ++ (if npPortsTo "agent-broker" == [ "http" "forge-proxy" ] then [ ]
        else [ "sandbox-isolation must admit the broker's http and forge-proxy ports, got ${builtins.toJSON (npPortsTo "agent-broker")}" ])
    ++ (if npPortsTo "conversation-router" == [ "self" ] then [ ]
        else [ "sandbox-isolation must admit the router's `self` port only, got ${builtins.toJSON (npPortsTo "conversation-router")}" ])
    ++ builtins.concatMap (n: if builtins.elem n (ctrPortNames "agent-broker") then [ ] else [ "sandbox-isolation names broker port `${n}`, which the broker does not declare" ]) (npPortsTo "agent-broker")
    ++ (if hasName routerPorts "self" then [ ] else [ "sandbox-isolation names router port `self`, which the router does not declare" ])
    ++ builtins.concatMap (app: if npPortsTo app == [ ] then [ ] else [ "sandbox-isolation lets sandboxes reach ${app}" ]) [ "agent-host" "agent-shared-db" "agent-webhooks" "agent-scheduler" "ui" ]
    ++ (if builtins.all (b: b.ipBlock.cidr == "0.0.0.0/0" && builtins.all (c: builtins.elem c b.ipBlock.except) [ "10.0.0.0/8" "100.64.0.0/10" "169.254.0.0/16" ]) npInternet && npInternet != [ ] then [ ]
        else [ "sandbox-isolation internet egress must except the pod/tailnet/metadata ranges" ])
    ++ (if ((evalPlatform { module = { lib, ... }: { imports = [ ./kubenix-config.nix ]; scooter.networkPolicy.enable = lib.mkForce false; }; }).config.kubernetes.resources.networkPolicies or { }) ? sandbox-isolation
        then [ "networkPolicy.enable = false still renders sandbox-isolation" ] else [ ])
    # The any-destination rule (no `to`) carries exactly udpPorts and tcpPorts.
    ++ (let
          np = platform.config.scooter.networkPolicy;
          anyRules = builtins.filter (r: !(r ? to)) npEgress;
          want = map (port: { protocol = "UDP"; inherit port; }) np.udpPorts
            ++ map (port: { protocol = "TCP"; inherit port; }) np.tcpPorts;
        in if builtins.length anyRules == 1 && (builtins.head anyRules).ports == want then [ ]
           else [ "sandbox-isolation any-destination rule must allow networkPolicy.udpPorts/tcpPorts ${builtins.toJSON want}, got ${builtins.toJSON (map (r: r.ports or [ ]) anyRules)}" ])
    # With no ports, the rule must vanish: an empty `ports` allows all egress.
    ++ (if builtins.any (r: !(r ? to)) (((evalPlatform { module = { lib, ... }: { imports = [ ./kubenix-config.nix ]; scooter.networkPolicy = { udpPorts = lib.mkForce [ ]; tcpPorts = lib.mkForce [ ]; }; }; }).config.kubernetes.resources.networkPolicies.sandbox-isolation.spec.egress))
        then [ "sandbox-isolation renders a port-less any-destination rule when udpPorts and tcpPorts are empty" ] else [ ]);

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
  # Every reader table grant waits for agent-db-migrate's table first, since the
  # two Jobs run concurrently and a crash-looping init stalls behind kubelet backoff.
  initLines = nixpkgsLib.splitString "\n" initScript;
  initGrantIdx = builtins.filter (i: builtins.match ".*ON TABLE public[.].*" (builtins.elemAt initLines i) != null)
    (nixpkgsLib.range 1 (builtins.length initLines - 1));
  initGrantProblems =
    (if initGrantIdx != [ ] then [ ] else [ "agent-postgres-init grants on no reader table — the wait_table check below is vacuous" ])
    ++ map (i: "agent-postgres-init grants before waiting for the table: ${nixpkgsLib.trim (builtins.elemAt initLines i)}")
      (builtins.filter (i: builtins.match ''[[:space:]]*wait_table .*'' (builtins.elemAt initLines (i - 1)) == null) initGrantIdx);
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

  # A contrib database grants other services table-scoped access on their own roles,
  # and `db.owner` moves it onto another service's role.
  grantPlatform = evalPlatform {
    module = { ... }: {
      imports = [ ./kubenix-config.nix ];
      contribs.aws.db.tables.permission_requests = {
        writers = [ "broker" "agent-host" ];
        readers = [ "conversation-router" ];
      };
    };
  };
  ownerPlatform = evalPlatform {
    module = { lib, ... }: {
      imports = [ ./kubenix-config.nix ];
      contribs.aws.db.owner = "agent-host";
      contribs.aws.db.tables.permission_requests.copyFrom = lib.mkForce null;
    };
  };
  scriptOf = r: let c = r.jobs.agent-postgres-init.spec.template.spec.containers.sql.command; in
    builtins.elemAt c (builtins.length c - 1);
  deployEnv = r: d: builtins.concatMap (c: c.env or [ ])
    (builtins.attrValues (r.deployments.${d}.spec.template.spec.containers or { }));
  grantRes = grantPlatform.config.kubernetes.resources;
  grantScript = scriptOf grantRes;
  has = re: str: builtins.match ".*${re}.*" str != null;
  contribGrantProblems =
    (if has ''GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."permission_requests" TO "agent_host"'' grantScript then [ ]
     else [ "contrib grants: agent-host is a writer of contrib_aws.permission_requests but its role gets no read-write grant" ])
    ++ (if has ''GRANT SELECT ON TABLE public."permission_requests" TO "conversation_router"'' grantScript then [ ]
        else [ "contrib grants: conversation-router is a reader of contrib_aws.permission_requests but its role gets no SELECT" ])
    ++ (if has ''GRANT CONNECT ON DATABASE "contrib_aws" TO "conversation_router"'' grantScript then [ ]
        else [ "contrib grants: conversation_router cannot CONNECT to contrib_aws" ])
    ++ (if contribEnvValue (deployEnv grantRes "agent-host") "CONTRIB_AWS_DB_NAME" == "contrib_aws" then [ ]
        else [ "contrib grants: agent-host.env.CONTRIB_AWS_DB_NAME missing — granted access but cannot find the database" ])
    ++ (if contribEnvValue (deployEnv grantRes "conversation-router") "CONTRIB_AWS_DB_NAME" == "contrib_aws" then [ ]
        else [ "contrib grants: conversation-router.env.CONTRIB_AWS_DB_NAME missing" ])
    # Without the grant, neither the role nor the pod learns about the database.
    ++ (if has ''TO "agent_host"'' initScript then [ "contrib grants: the example grants agent_host on a contrib database nobody listed it for" ] else [ ])
    ++ (if contribEnvValue hostEnv "CONTRIB_AWS_DB_NAME" == null then [ ]
        else [ "contrib grants: agent-host.env.CONTRIB_AWS_DB_NAME set though agent-host has no access" ])
    ++ (if has ''CREATE DATABASE "contrib_aws" OWNER "agent_host"'' (scriptOf ownerPlatform.config.kubernetes.resources) then [ ]
        else [ "db.owner = agent-host: contrib_aws is not created on the agent_host role" ])
    ++ (if hasWord "contrib_aws:agent_host" (toString (contribEnvValue
          ownerPlatform.config.kubernetes.resources.jobs.agent-db-migrate.spec.template.spec.containers.migrate.env "DB_ENVS")) then [ ]
        else [ "db.owner = agent-host: contrib_aws is not migrated as agent_host" ]);

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

  # The /contrib-api relay: a tab's `api = true` reaches the agent-host as a row in
  # CONTRIB_USER_API_JSON, only while its contrib is enabled, and the broker trusts the
  # relayed user header from the agent-host alone.
  hostEnvOf = extra:
    let
      e = evalPlatform {
        module = { ... }: {
          imports = [ ./kubenix-config.nix ];
          config = extra;
        };
      };
      ctrs = builtins.attrValues (e.config.kubernetes.resources.deployments.agent-host.spec.template.spec.containers or { });
    in builtins.concatMap (c: c.env or [ ]) ctrs;
  userApiOf = env:
    let m = builtins.filter (e: e.name == "CONTRIB_USER_API_JSON") env;
    in if m == [ ] then { } else builtins.fromJSON (builtins.head m).value;
  relayAccounts =
    let m = builtins.filter (e: e.name == "USER_RELAY_SERVICE_ACCOUNTS") brokerEnv;
    in if m == [ ] then "" else (builtins.head m).value or "";
  contribApiProblems =
    (if userApiOf hostEnv ? echo
     then [ "host.env.CONTRIB_USER_API_JSON has an echo row while echo is disabled — the relay is not gated on the contrib's `enable`" ] else [ ])
    ++ (if ((userApiOf (hostEnvOf { contribs.echo.enable = nixpkgsLib.mkForce true; })).echo.brokerPrefix or null) == "/echo" then [ ]
        else [ "enabling echo (whose tab sets api = true) did not put { echo = { brokerPrefix = \"/echo\"; }; } in host.env.CONTRIB_USER_API_JSON" ])
    ++ (if builtins.match ".*:agent-host" relayAccounts != null then [ ]
        else [ "broker.env.USER_RELAY_SERVICE_ACCOUNTS does not name the agent-host ('${relayAccounts}') — every /contrib-api call would 403" ])
    ++ (if tabsThrow (nixpkgsLib.recursiveUpdate (echoOn [ (echoTab // { api = true; }) ]) { contribs.echo.services.broker.enable = nixpkgsLib.mkForce false; }) then [ ]
        else [ "a settings tab with api = true rendered for a contrib without a broker half — its relay would 404 at the broker" ]);

  # System tasks: scooter.systemTasks renders into the scheduler's ConfigMap, contribs map
  # in as "<contrib>-<id>" only while enabled, and bad config fails the render.
  sysEval = extra: evalPlatform {
    module = { ... }: { imports = [ ./kubenix-config.nix ]; config = extra; };
  };
  sysJsonOf = e: e.config.kubernetes.resources.configMaps.scheduler-system-tasks.data."system-tasks.json";
  sysById = e: builtins.listToAttrs (map (t: { name = t.id; value = t; }) (builtins.fromJSON (sysJsonOf e)));
  sysThrows = extra: !(builtins.tryEval (builtins.deepSeq (sysJsonOf (sysEval extra)) true)).success;
  sysBase = sysById platform;
  sysEcho = sysById (sysEval { contribs.echo.enable = nixpkgsLib.mkForce true; });
  sysPersEval = extra: sysEval ({ contribs.personalization.enable = nixpkgsLib.mkForce true; } // extra);
  sysPers = (sysById (sysPersEval { })).personalization-refresh-profile or { };
  sysEchoTuned = sysById (sysEval {
    contribs.echo.enable = nixpkgsLib.mkForce true;
    scooter.systemTasks.echo-greet.every = "4h";
  });
  sysFast = sysById (sysEval { scooter.agent.availableModels.goose."us.anthropic.claude-opus-4-8".fast = true; });
  schedImageOf = e: e.config.scooter.images.agent-scheduler.package.drvPath;
  publishedSchedImage = flake.packages.${system}.scheduler-image.drvPath;
  schedEnvVal = name: let m = builtins.filter (e: e.name == name) schedEnv; in if m == [ ] then "" else (builtins.head m).value or "";
  brokerEnvVal = name: let m = builtins.filter (e: e.name == name) brokerEnv; in if m == [ ] then "" else (builtins.head m).value or "";
  health = sysBase.broker-health or { };
  sysTaskProblems =
    (if health != { } then [ ] else [ "the example's systemTasks.broker-health is missing from the scheduler-system-tasks ConfigMap" ])
    ++ (if (health.interval_seconds or null) == 900 && (health.timeout_seconds or null) == 60 && (health.cron or 1) == null then [ ]
        else [ "broker-health should render interval_seconds 900, timeout_seconds 60 and no cron" ])
    ++ (if nixpkgsLib.hasPrefix builtins.storeDir (health.command or "") then [ ]
        else [ "broker-health's command is not a store path" ])
    ++ (if (health.model or null) == "us.anthropic.claude-sonnet-4-6" then [ ]
        else [ "with no model flagged `fast`, a task should run on the default model, got '${toString (health.model or null)}'" ])
    ++ (if ((sysFast.broker-health or { }).model or null) == "us.anthropic.claude-opus-4-8" then [ ]
        else [ "a model flagged `fast` is not what a task without `model` runs on" ])
    ++ (if !(builtins.hasContext (sysJsonOf platform)) then [ ]
        else [ "the scheduler-system-tasks ConfigMap carries string context, so rendering manifests would build every task" ])
    ++ (if !(sysBase ? echo-greet) then [ ]
        else [ "echo is disabled but its system task rendered" ])
    ++ (if (sysEcho.echo-greet.interval_seconds or null) == 86400 && nixpkgsLib.hasSuffix "/bin/echo-greet" (sysEcho.echo-greet.command or "") then [ ]
        else [ "enabling echo did not render its task as scooter.systemTasks.echo-greet (every 1d, bin/echo-greet)" ])
    ++ (if !(sysBase ? personalization-refresh-profile) then [ ]
        else [ "personalization is disabled but its refresh-profile task rendered" ])
    ++ (if (sysPers.interval_seconds or null) == 3600 && builtins.elem "10d" (sysPers.args or [ ]) then [ ]
        else [ "enabling personalization did not render personalization-refresh-profile (every 1h, --interval 10d)" ])
    ++ (if schedImageOf (sysPersEval { scooter.systemTasks.broker-health.enable = false; }) == publishedSchedImage then [ ]
        else [ "with personalization enabled the scheduler image differs from the published one" ])
    ++ (if (sysEchoTuned.echo-greet.interval_seconds or null) == 14400 then [ ]
        else [ "an operator could not retune a contrib task (systemTasks.echo-greet.every = \"4h\")" ])
    ++ (if !((sysById (sysEval { scooter.systemTasks.broker-health.enable = false; })) ? broker-health) then [ ]
        else [ "systemTasks.<id>.enable = false did not drop the task" ])
    ++ (if sysThrows { scooter.systemTasks.bare = { command = "sh"; every = "1h"; }; } then [ ]
        else [ "a bare-name system task command (\"sh\") rendered; it must be a store path" ])
    ++ (if sysThrows { scooter.systemTasks.broker-health.cron = "0 * * * *"; } then [ ]
        else [ "a system task with both `every` and `cron` rendered" ])
    ++ (if sysThrows { scooter.systemTasks.broker-health.every = nixpkgsLib.mkForce null; } then [ ]
        else [ "a system task with neither `every` nor `cron` rendered" ])
    ++ (if sysThrows { scooter.systemTasks.broker-health.every = nixpkgsLib.mkForce "15 minutes"; } then [ ]
        else [ "a system task with an unparseable `every` rendered" ])
    ++ (if sysThrows { scooter.systemTasks.broker-health.model = "not-a-model"; } then [ ]
        else [ "a system task `model` outside availableModels rendered" ])
    ++ (if sysThrows { scooter.agent.availableModels.goose = {
          "us.anthropic.claude-opus-4-8".fast = true;
          "us.anthropic.claude-sonnet-4-6".fast = true;
        }; } then [ ]
        else [ "two models flagged `fast` rendered" ])
    # The image: a deployment's own task is in it; with none, it is the published image.
    ++ (if schedImageOf (sysEval { scooter.systemTasks.broker-health.enable = false; }) == publishedSchedImage then [ ]
        else [ "with no operator task, the scheduler image differs from the published one, so its content tag would not exist on the registry" ])
    ++ (if schedImageOf platform != publishedSchedImage then [ ]
        else [ "an operator task did not change the scheduler image, so its command is not in the image" ])
    # The Deployment names this config's image, not upstream's.
    ++ (let
          tag = platform.config.scooter.imagesContentTag platform.config.scooter.images.agent-scheduler.package;
          ctrs = builtins.attrValues res.deployments.agent-scheduler.spec.template.spec.containers;
        in if builtins.any (c: nixpkgsLib.hasSuffix ":${tag}" (c.image or "")) ctrs then [ ]
           else [ "the scheduler Deployment does not name the image this config built (tag ${tag})" ])
    ++ (if schedEnvVal "SYSTEM_TASKS_PATH" != "" && schedEnvVal "SCHEDULER_URL" != "" then [ ]
        else [ "scheduler.env SYSTEM_TASKS_PATH / SCHEDULER_URL (the scheduler cannot find or hand out its system tasks)" ])
    ++ (if builtins.match ".*:agent-scheduler" (brokerEnvVal "SYSTEM_TASK_SERVICE_ACCOUNTS") != null then [ ]
        else [ "broker.env.SYSTEM_TASK_SERVICE_ACCOUNTS does not name the scheduler, so a task's /system calls would 403" ]);

  # ask-user: its blocking tool reaches the agent-host as BLOCKING_TOOLS_JSON and its card
  # reaches the UI manifest, both only while it is enabled, and a kind outside the
  # contrib's namespace or a missing entry fails the eval.
  resolveInterruptRenderers = import ../contrib/interrupt-renderers.nix { lib = nixpkgsLib; };
  renderersWith = extra:
    let
      e = evalPlatform {
        module = { ... }: {
          imports = [ ./kubenix-config.nix ];
          config = extra;
        };
      };
    in resolveInterruptRenderers (nixpkgsLib.filterAttrs (_: c: c.enable) e.config.contribs);
  renderersThrow = extra: !(builtins.tryEval (builtins.deepSeq (renderersWith extra) true)).success;
  blockingOf = env:
    let m = builtins.filter (e: e.name == "BLOCKING_TOOLS_JSON") env;
    in if m == [ ] then { } else builtins.fromJSON (builtins.head m).value;
  askUserOff = { contribs.ask-user.enable = nixpkgsLib.mkForce false; };
  # ask-user provides awaiting-input: agent-host and the router find its database by feature.
  awaitingOf = extra:
    let
      e = evalPlatform {
        module = { ... }: {
          imports = [ ./kubenix-config.nix ];
          config = extra;
        };
      };
      envOf = d: builtins.concatMap (c: c.env or [ ])
        (builtins.attrValues (e.config.kubernetes.resources.deployments.${d}.spec.template.spec.containers or { }));
      valueIn = d: map (x: x.value) (builtins.filter (x: x.name == "AWAITING_INPUT_DB_NAME") (envOf d));
    in { host = valueIn "agent-host"; router = valueIn "conversation-router"; };
  awaitingOn = awaitingOf { };
  askUserProblems =
    (if ((blockingOf hostEnv).AskUserQuestion.kind or null) == "ask-user.questions" then [ ]
     else [ "host.env.BLOCKING_TOOLS_JSON has no AskUserQuestion -> ask-user.questions row while ask-user is enabled" ])
    ++ (if blockingOf (hostEnvOf askUserOff) == { } then [ ]
        else [ "host.env.BLOCKING_TOOLS_JSON is set while ask-user is disabled — blocking tools are not gated on the contrib's `enable`" ])
    ++ (if ((renderersWith { })."ask-user.questions".entry or null) == "ask-user/ui/QuestionCard.tsx" then [ ]
        else [ "the ask-user.questions renderer is not in the manifest as ask-user/ui/QuestionCard.tsx" ])
    ++ (if (renderersWith askUserOff) ? "ask-user.questions"
        then [ "the ask-user.questions renderer is in the manifest while ask-user is disabled" ] else [ ])
    ++ (if renderersThrow { contribs.ask-user.ui.interruptRenderers."other.questions".entry = "ui/QuestionCard.tsx"; } then [ ]
        else [ "an interrupt renderer kind outside `<contrib>.` rendered — request kinds are no longer scoped by contrib" ])
    ++ (if renderersThrow { contribs.ask-user.ui.interruptRenderers."ask-user.more".entry = "ui/Missing.tsx"; } then [ ]
        else [ "an interrupt renderer whose entry does not exist rendered" ])
    ++ (if !(builtins.tryEval (builtins.deepSeq (hostEnvOf { contribs.ask-user.agent.blockingTools.Other.kind = "aws.x"; }) true)).success then [ ]
        else [ "a blocking tool kind outside `<contrib>.` rendered" ])
    ++ (if awaitingOn == { host = [ "contrib_ask_user" ]; router = [ "contrib_ask_user" ]; } then [ ]
        else [ "AWAITING_INPUT_DB_NAME is not contrib_ask_user on agent-host and the router: ${builtins.toJSON awaitingOn}" ])
    ++ (if awaitingOf askUserOff == { host = [ ]; router = [ ]; } then [ ]
        else [ "AWAITING_INPUT_DB_NAME is set while ask-user is disabled" ])
    ++ (if !(builtins.tryEval (builtins.deepSeq (awaitingOf { contribs.aws.db.provides = [ "awaiting-input" ]; }) true)).success then [ ]
        else [ "two contribs providing awaiting-input rendered" ]);

  # Hooks: only name-conversation by default, opt-out, contrib namespacing and gating.
  hooksOf = env:
    let m = builtins.filter (e: e.name == "AGENT_HOOKS_JSON") env;
    in if m == [ ] then [ ] else builtins.fromJSON (builtins.head m).value;
  hookIds = extra: map (h: h.id) (hooksOf (hostEnvOf extra));
  echoHook = enable: {
    contribs.echo.enable = nixpkgsLib.mkForce enable;
    contribs.echo.agent.hooks.ping = { event = "PreToolUse"; command = "exit 0"; };
  };
  stopHook = enable: { scooter.agent.hooks.nag = { inherit enable; event = "Stop"; command = "exit 0"; userCanDisable = true; }; };
  hookProblems =
    (if hookIds { } == [ "name-conversation" ] then [ ] else [ "AGENT_HOOKS_JSON has undeclared hooks: ${builtins.toJSON (hookIds { })}" ])
    ++ (let d = hooksOf (hostEnvOf { }); in
        if d != [ ] && ((builtins.head d).when or null) == "untitled" then [ ]
        else [ "the default name-conversation hook lost its `when = untitled` pre-filter" ])
    ++ (let f = builtins.filter (h: h.id == "nag") (hooksOf (hostEnvOf (stopHook true))); in
        if f != [ ] && (builtins.head f).event == "Stop" && (builtins.head f).userCanDisable then [ ]
        else [ "a declared opt-out-able Stop hook is not in AGENT_HOOKS_JSON" ])
    ++ (if !(builtins.elem "nag" (hookIds (stopHook false))) then [ ]
        else [ "a hook still renders with enable = false" ])
    ++ (if builtins.elem "echo.ping" (hookIds (echoHook true)) then [ ]
        else [ "an enabled contrib's hook is not in AGENT_HOOKS_JSON as <contrib>.<id>" ])
    ++ (if !(builtins.elem "echo.ping" (hookIds (echoHook false))) then [ ]
        else [ "a disabled contrib's hook is in AGENT_HOOKS_JSON" ]);

  # The UI pod serves the DEPLOYMENT's contrib manifest, mounted from a ConfigMap, so a
  # contrib left off here shows no settings tab even though the image's built-in
  # manifest (built from the repo's list) has one.
  uiManifestOf = extra:
    let
      e = evalPlatform {
        module = { ... }: {
          imports = [ ./kubenix-config.nix ];
          config = extra;
        };
      };
      r = e.config.kubernetes.resources;
      mounted = builtins.any (c: builtins.any (m: m.mountPath == "/etc/scooter-ui/contrib") (c.volumeMounts or [ ]))
        (builtins.attrValues r.deployments.ui.spec.template.spec.containers);
    in if mounted then builtins.fromJSON r.configMaps.ui-contrib-manifest.data."manifest.json" else null;
  uiManifestProblems =
    let off = uiManifestOf { }; on = uiManifestOf { contribs.echo.enable = nixpkgsLib.mkForce true; };
    in if off == null then [ "the UI pod does not mount the deployment's contrib manifest at /etc/scooter-ui/contrib" ]
    else (if off.settingsTabs ? echo then [ "the UI manifest has the echo settings tab while echo is disabled" ] else [ ])
      ++ (if on.settingsTabs ? echo then [ ] else [ "enabling echo did not put its settings tab in the UI's mounted manifest" ]);

  # shares' Shares tab and scooter-embed fence reach the mounted manifest and the relay
  # only while it is enabled, and a clashing fence or a missing entry fails the eval.
  sharesOff = { contribs.shares.enable = nixpkgsLib.mkForce false; };
  convUiThrow = extra: !(builtins.tryEval (builtins.deepSeq (uiManifestOf extra) true)).success;
  conversationUiProblems =
    let on = uiManifestOf { }; off = uiManifestOf sharesOff; in
    (if (on.panels.shares.entry or null) == "shares/ui/Panel.tsx" then [ ]
     else [ "the UI manifest has no shares panel at shares/ui/Panel.tsx while shares is enabled" ])
    ++ (if (on.markdownFences."scooter-embed".entry or null) == "shares/ui/Embed.tsx" then [ ]
        else [ "the UI manifest has no scooter-embed fence at shares/ui/Embed.tsx while shares is enabled" ])
    ++ (if (off.panels or { }) ? shares || (off.markdownFences or { }) ? "scooter-embed"
        then [ "the UI manifest has shares' panel or fence while shares is disabled" ] else [ ])
    ++ (if ((userApiOf hostEnv).shares.brokerPrefix or null) == "/shares" then [ ]
        else [ "shares' panel sets api = true but host.env.CONTRIB_USER_API_JSON has no /shares row" ])
    ++ (if userApiOf (hostEnvOf sharesOff) ? shares
        then [ "host.env.CONTRIB_USER_API_JSON has a shares row while shares is disabled" ] else [ ])
    ++ (if convUiThrow { contribs.echo.enable = nixpkgsLib.mkForce true; contribs.echo.ui.markdownFences."scooter-embed".entry = "ui/SettingsTab.tsx"; } then [ ]
        else [ "two contribs claiming one fence language rendered" ])
    ++ (if convUiThrow { contribs.shares.ui.panel.entry = nixpkgsLib.mkForce "ui/Missing.tsx"; } then [ ]
        else [ "a panel whose entry does not exist rendered" ]);

  # scooter.uploads: the body-limit formula, and that every layer gets it. The example
  # sets 50MB x 4 on an nginx-class Ingress.
  uploadBody = import ../modules/upload-max-body.nix;
  uploadsEval = extra:
    (evalPlatform {
      module = { ... }: {
        imports = [ ./kubenix-config.nix ];
        config = extra;
      };
    }).config.kubernetes.resources;
  envOf = r: dep: name:
    let
      ctrs = builtins.attrValues (r.deployments.${dep}.spec.template.spec.containers or { });
      m = builtins.filter (e: e.name == name) (builtins.concatMap (c: c.env or [ ]) ctrs);
    in if m == [ ] then null else (builtins.head m).value;
  bodyAnn = r: r.ingresses.agent-host.metadata.annotations."nginx.ingress.kubernetes.io/proxy-body-size" or null;
  traefikRes = uploadsEval { scooter.ingress.className = nixpkgsLib.mkForce "traefik"; };
  overrideRes = uploadsEval {
    scooter.ingress.annotations."nginx.ingress.kubernetes.io/proxy-body-size" = "1g";
  };
  uploadsProblems =
    (if uploadBody { maxFileBytes = 25 * 1024 * 1024; maxFilesPerMessage = 4; } == "144m" then [ ]
     else [ "upload-max-body: 4 x 25MB should give 144m (the ui image's render default)" ])
    ++ (if uploadBody { maxFileBytes = 50 * 1024 * 1024; maxFilesPerMessage = 1; } == "72m" then [ ]
        else [ "upload-max-body: 1 x 50MB should give 72m" ])
    ++ (if uploadBody { maxFileBytes = 1024; maxFilesPerMessage = 1; } == "2m" then [ ]
        else [ "upload-max-body: a tiny cap should still get the 1MiB headroom (2m)" ])
    ++ (if envOf res "agent-host" "FILE_MAX_BYTES" == toString (50 * 1024 * 1024)
          && envOf res "agent-host" "FILE_MAX_PER_MESSAGE" == "4" then [ ]
        else [ "agent-host.env FILE_MAX_BYTES / FILE_MAX_PER_MESSAGE do not carry scooter.uploads" ])
    ++ (if envOf res "ui" "UPLOAD_MAX_BODY" == "287m" then [ ]
        else [ "ui.env UPLOAD_MAX_BODY should be 287m for 4 x 50MB (got ${toString (envOf res "ui" "UPLOAD_MAX_BODY")})" ])
    ++ (if bodyAnn res == "287m" then [ ]
        else [ "the nginx-class Ingress lacks proxy-body-size = UPLOAD_MAX_BODY, so ingress-nginx's 1m default would 413 uploads" ])
    ++ (if bodyAnn traefikRes == null then [ ]
        else [ "a non-nginx Ingress got the ingress-nginx proxy-body-size annotation" ])
    ++ (if bodyAnn overrideRes == "1g" then [ ]
        else [ "an explicit proxy-body-size annotation did not win over the derived one" ]);

  # A replaced library rebuilds exactly the images shipping it.
  forkedLib = evalPlatform {
    module = { config, ... }: {
      imports = [ ./kubenix-config.nix ];
      scooter.packages.scooter-lib = config.scooter.config.buildPkgs.python3Packages.toolz;
    };
  };
  imageDrv = p: n: p.config.scooter.images.${n}.package.drvPath;
  packageProblems =
    nixpkgsLib.concatMap (n: if imageDrv forkedLib n != imageDrv platform n then [ ]
      else [ "scooter.packages.scooter-lib override did not reach the ${n} image" ])
      [ "agent-broker" "agent-webhooks" "agent-scheduler" ]
    ++ (if imageDrv forkedLib "conversation-router" == imageDrv platform "conversation-router" then [ ]
        else [ "scooter.packages.scooter-lib override changed conversation-router, which does not use it" ]);

  allProblems = packageProblems ++ uploadsProblems ++ sysTaskProblems ++ askUserProblems ++ hookProblems ++ disabledContribProblems ++ settingsTabProblems ++ uiManifestProblems ++ conversationUiProblems ++ contribApiProblems ++ dirSkillProblems ++ legacyRootProblems ++ searchProblems ++ oneEntrypointProblems ++ ownerProblems ++ jobImmutabilityProblems ++ sizeGuardProblems ++ skillProblems ++ problems ++ ddProblems ++ atProblems ++ googleProblems ++ ghOwnersProblems ++ sharesProblems ++ cfProblems ++ csProblems ++ dbProblems ++ puProblems ++ mdProblems ++ ngProblems' ++ rolloutProblems ++ testProblems ++ schedProblems ++ otelProblems ++ coverageProblems ++ contribCoverageProblems ++ brokerDbProblems ++ dupEnvProblems ++ contribSeamProblems ++ sandboxSeamProblems ++ volumeProblems ++ approvalProblems ++ stage2Problems ++ contribDbProblems ++ contribGrantProblems ++ retireProblems ++ initGrantProblems ++ fgaProblems ++ sslProblems ++ vacuityProblems ++ approverProblems ++ selfAccessProblems ++ npProblems ++ sandboxOriginProblems ++ enforceProblems;
in
if allProblems == [ ]
then "ok: deployments = ${haveDeps}; datadog + airtable + brave + kagi + duckduckgo (three search providers, each with its own tool) + configFiles + broker config-rollout + models + scheduler + otel wired; example covers every scooter.* namespace and every shipped contrib's own options; skills gated on the contrib being built; sandbox-shaping env is agent-host-only (one provisioning entrypoint); sandbox size default guard fires on 0 and 2 defaults; the renamed root (agentSandbox.*) fails the render; contribs reach the platform eval and configuring an unshipped one fails the render; deploy-time Jobs are spec-hash named; a scooter.packages override reaches exactly the images that use it\n"
else builtins.throw "example manifests missing: ${builtins.concatStringsSep ", " allProblems}"
