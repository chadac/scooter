# Render check for the local preset (flake `checks.local-manifests`): each provider's
# render evaluates, and the resources and wiring scooter-local relies on are present,
# so a platform change that breaks the preset fails CI rather than a user's `up`.
#
# Reads kubenix's resolved `objects` (what the YAML serializes), since the raw
# `resources` tree still holds the modules' mkIf wrappers.
{ pkgs, lib, renders }:
let
  objects = provider: renders.${provider}.config.kubernetes.objects;
  find = provider: kind: name:
    let hits = builtins.filter (o: o.kind == kind && o.metadata.name == name) (objects provider);
    in if hits == [ ] then null else builtins.head hits;

  agentHost = provider: find provider "Deployment" "agent-host";
  controllerEnv = provider: name:
    let
      ctr = builtins.head (find provider "Deployment" "conversation-controller").spec.template.spec.containers;
      hits = builtins.filter (e: e.name == name) (ctr.env or [ ]);
    in if hits == [ ] then null else (builtins.head hits).value or null;
  agentHostContainer = provider: builtins.head (agentHost provider).spec.template.spec.containers;
  envValue = provider: name:
    let hits = builtins.filter (e: e.name == name) ((agentHostContainer provider).env or [ ]);
    in if hits == [ ] then null else (builtins.head hits).value or (builtins.head hits).valueFrom;

  # Resources every render must have.
  expect = {
    Deployment = [ "agent-host" "agent-broker" "ui" "conversation-controller" "conversation-router" ];
    Service = [ "agent-host" "ui" ];
    Ingress = [ "agent-host" ];
    PersistentVolume = [ "agent-host-assets" ];
  };
  structural = builtins.concatLists (lib.mapAttrsToList (provider: _:
    builtins.concatLists (lib.mapAttrsToList (kind: names:
      map (n: "${provider}: ${kind}/${n} missing")
        (builtins.filter (n: find provider kind n == null) names)) expect)) renders);

  # The single-machine wiring.
  perProvider = builtins.concatLists (lib.mapAttrsToList (provider: _:
    let
      ingress = (find provider "Ingress" "agent-host").spec;
      rule = builtins.head ingress.rules;
      pv = (find provider "PersistentVolume" "agent-host-assets").spec;
    in
    lib.optional (rule ? host) "${provider}: the Ingress names a host; it must be a catch-all"
    ++ lib.optional (ingress.ingressClassName or null != "traefik") "${provider}: ingressClassName is not traefik"
    ++ lib.optional (envValue provider "AUTH_ENFORCE" != null) "${provider}: AUTH_ENFORCE is set; the preset runs without an auth proxy"
    ++ lib.optional (!(pv ? hostPath)) "${provider}: the assets PV is not a hostPath"
    ++ lib.optional ((agentHost provider).spec.replicas or 1 != 1) "${provider}: agent-host has more than one replica"
    ++ lib.optional (controllerEnv provider "AGENT_HOST_MIN_REPLICAS" != "1") "${provider}: the agent-host autoscaler floor is not 1"
  ) renders);

  providerWiring =
    lib.optional (!(lib.hasSuffix "/agent-host-claude:@AGENT_HOST_CLAUDE_TAG@" (agentHostContainer "claude-code").image))
      "claude-code: agent-host image is ${(agentHostContainer "claude-code").image}, not agent-host-claude with the tag placeholder"
    ++ lib.optional (envValue "claude-code" "GOOSE_PROVIDER" != "claude-code") "claude-code: GOOSE_PROVIDER is not claude-code"
    ++ lib.optional (envValue "anthropic" "GOOSE_PROVIDER" != "anthropic") "anthropic: GOOSE_PROVIDER is not anthropic"
    ++ lib.optional ((envValue "anthropic" "ANTHROPIC_API_KEY").secretKeyRef.name or null != "agent-anthropic-key")
      "anthropic: ANTHROPIC_API_KEY is not read from the agent-anthropic-key Secret"
    ++ lib.optional (envValue "ollama" "GOOSE_PROVIDER" != "ollama") "ollama: GOOSE_PROVIDER is not ollama"
    ++ lib.optional (envValue "ollama" "OLLAMA_HOST" != "@OLLAMA_HOST@") "ollama: OLLAMA_HOST is not the placeholder"
    ++ lib.optional (envValue "ollama" "GOOSE_MODEL" != "@OLLAMA_MODEL@") "ollama: GOOSE_MODEL is not the placeholder";

  problems = structural ++ perProvider ++ providerWiring;
in
if problems != [ ] then
  throw "local preset render check failed:\n  ${lib.concatStringsSep "\n  " problems}"
else
  pkgs.runCommand "local-manifests-check" {
    # The YAML renders themselves, so the check also builds what `up` applies.
    renders = lib.mapAttrsToList (_: r: r.config.kubernetes.resultYAML) renders;
  } ''
    for r in $renders; do grep -q 'kind: Deployment' "$r"; done
    echo ok > $out
  ''
