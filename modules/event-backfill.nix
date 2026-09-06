# ONE-TIME migration: conversation event logs from the history mirror PVC → Postgres.
#
# The event log cutover moved conversation events from the NFS mirror (agent-host-history PVC)
# to Postgres. Deployments that had conversations BEFORE the cutover have their history still
# on the PVC; this Job reads every conversation's events.jsonl from the mirror and loads it
# into Postgres, verifying the row count and checksum chain against what was read from the file.
#
# SAFETY: The Job CANNOT run unless retainForMigration = true (enforced by an eval-time
# assert — see below). This keeps the PVC provisioned for the whole run. The correct sequence:
#   1. retainForMigration = true (deploy)  → PVC stays provisioned
#   2. eventBackfill.enable = true (deploy) → Job runs
#   3. kubectl logs -f job/agent-event-backfill → verify ok=true for ALL conversations
#   4. eventBackfill.enable = false (deploy) → Job removed
#   5. retainForMigration = false (deploy) → PVC reclaimed
#
# EPHEMERAL, RUN ONCE: verify the report shows every conversation OK, then turn it OFF. The
# load is NOT idempotent — backfillConversation inserts without an ON CONFLICT clause (the
# (conversation_id, seq) primary key is a correctness backstop against a second writer), so a
# re-run over a conversation already loaded fails on the duplicate key. Run against a fresh
# agent_host table; if a run fails partway, truncate what it wrote before retrying.
#
# THE JOB VERIFIES, IT DOES NOT ASSUME. For every conversation it compares the row count
# against the line count AND the chain recomputed from the FILE against the chain the load
# reported. One bad conversation fails the whole run; a conversation directory with no log is
# a failure, not a skip. This prevents the "127 of 128 conversations loaded, exit 0" failure
# where the mirror is reclaimed and history is destroyed.
#
# See services/agent-host/src/session/eventBackfill.ts and the contract tests.

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  bcfg = cfg.eventBackfill;
  ns = cfg.namespace;

  # The conversation controller's history mirror config (where the PVC name comes from)
  hmCfg = cfg.conversationController.historyMirror;
in
{
  options.agentSandbox.eventBackfill = with lib; {
    enable = mkEnableOption ''
      the one-shot event backfill Job (history mirror PVC → Postgres). Turn ON to run the
      migration, verify the report shows all conversations OK, then turn OFF. REQUIRES
      historyMirror.retainForMigration = true (enforced by an eval-time assert) so the PVC
      cannot be deleted while the backfill is running'';

    image = mkOption {
      type = types.str;
      default = cfg.agentHostImage;
      description = ''
        The agent-host image (it carries the compiled dist/scripts/runEventBackfill.js and its
        deps). Defaults to the same image agent-host runs, so the backfill loads with the exact
        schema + integrity code the live service uses.
      '';
    };

    mirrorPath = mkOption {
      type = types.str;
      default = "/mirror/conversations";
      description = ''
        Path inside the mounted history mirror PVC where conversation directories live.
        Each conversation is a directory named by its ID, containing an events.jsonl file.
      '';
    };
  };

  config = lib.mkIf bcfg.enable {
    # SAFETY GATE: the backfill Job CANNOT render unless the PVC is retained. Without this,
    # an operator could enable the Job while retainForMigration = false, so the PVC the Job
    # reads from is never provisioned (or is reclaimed out from under a running Job), destroying
    # the only copy of history the backfill hadn't yet loaded. kubenix modules have no NixOS-style
    # `assertions` option, so this is an eval-time `assert` (the repo's convention — see the
    # albVerify assert in platform.nix). It sits on the resource VALUE, not on `config` itself:
    # wrapping the whole config attrset would force the condition before the module system can
    # read config's structure — an infinite recursion.
    kubernetes.resources.jobs.agent-event-backfill =
      assert lib.assertMsg hmCfg.retainForMigration ''
        agentSandbox.eventBackfill.enable = true requires
        agentSandbox.conversationController.historyMirror.retainForMigration = true.

        The backfill Job reads conversation history FROM the mirror PVC, so the PVC must stay
        provisioned for the whole run. Enabling the backfill without retaining the PVC would
        mount a volume that is absent (or being reclaimed), losing any history not yet loaded.

        Safe sequence:
          1. historyMirror.retainForMigration = true  (deploy)
          2. eventBackfill.enable = true              (deploy)
          3. kubectl logs -f job/agent-event-backfill (verify ok=true for ALL conversations)
          4. eventBackfill.enable = false             (deploy)
          5. historyMirror.retainForMigration = false (deploy, reclaims the PVC)
      '';
      {
        metadata = { 
          name = "agent-event-backfill"; 
          namespace = ns;
          labels = {
            "app.kubernetes.io/name" = "agent-event-backfill";
            "app.kubernetes.io/component" = "migration";
            "scooter.chadac.org/blocks-pvc-deletion" = "agent-host-history";
          };
        };
        spec = {
          backoffLimit = 2;
          template = {
            metadata.labels = {
              app = "agent-event-backfill";
              "app.kubernetes.io/name" = "agent-event-backfill";
              "app.kubernetes.io/component" = "migration";
            };
            spec = {
              restartPolicy = "OnFailure";
              # Same service account as agent-host (needs db secrets)
              serviceAccountName = "agent-host";
              securityContext = {
                fsGroup = 0;
                fsGroupChangePolicy = "OnRootMismatch";
              };
              containers.backfill = {
                name = "backfill";
                image = bcfg.image;
                imagePullPolicy = cfg.pullPolicy;
                # Use the packaged `agent-host-backfill` bin, NOT `node
                # dist/scripts/...`: the image sets no WorkingDir and only links
                # /bin (the app's dist/ lives deep in the store, unreachable by a
                # relative path from CWD /), so `node dist/...` exits MODULE_NOT_FOUND
                # → BackoffLimitExceeded. The npm bin shim execs node against the
                # script's absolute store path, so it runs from any CWD. Why: PR #487.
                command = [
                  "agent-host-backfill"
                  bcfg.mirrorPath
                ];
                # The SAME agent_host DB wiring agent-host itself uses (discrete
                # AGENT_HOST_DB_* vars + the agent-pg-agent-host password Secret, not a
                # DATABASE_URL) so the backfill writes to the exact database + credentials the
                # live service reads from. runEventBackfill.js assembles the DSN from these.
                env = [
                  { name = "AGENT_HOST_DB_HOST"; value = cfg.postgres.host; }
                  { name = "AGENT_HOST_DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "AGENT_HOST_DB_NAME"; value = "agent_host"; }
                  { name = "AGENT_HOST_DB_USER"; value = "agent_host"; }
                  {
                    name = "AGENT_HOST_DB_PASSWORD";
                    valueFrom.secretKeyRef = { name = "agent-pg-agent-host"; key = "password"; };
                  }
                  { name = "NODE_ENV"; value = "production"; }
                ] ++ lib.optional (cfg.postgres.sslmode != null)
                  { name = "AGENT_HOST_DB_SSLMODE"; value = cfg.postgres.sslmode; };
                volumeMounts = [
                  {
                    name = "mirror";
                    mountPath = "/mirror";
                    readOnly = true;
                  }
                ];
                resources = {
                  requests = {
                    memory = "512Mi";
                    cpu = "500m";
                  };
                  limits = {
                    memory = "2Gi";
                    cpu = "2000m";
                  };
                };
              };
              volumes = [
                {
                  name = "mirror";
                  persistentVolumeClaim = {
                    claimName = "agent-host-history";
                    readOnly = true;
                  };
                }
              ];
            };
          };
        };
      };
  };
}
