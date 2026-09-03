# ONE-TIME migration: conversation event logs from the history mirror PVC → Postgres.
#
# The event log cutover moved conversation events from the NFS mirror (agent-host-history PVC)
# to Postgres. Deployments that had conversations BEFORE the cutover have their history still
# on the PVC; this Job reads every conversation's events.jsonl from the mirror and loads it
# into Postgres, verifying the row count and checksum chain against what was read from the file.
#
# EPHEMERAL: run it ONCE during the cutover (with `historyMirror.retainForMigration = true`
# so the PVC stays provisioned while nothing mounts it), verify the report shows every
# conversation OK, then set the flag back false (and later reclaim the PVC). The Job is
# idempotent (backfillConversation skips rows already present), so a re-run only loads what's
# missing.
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
      migration, verify the report shows all conversations OK, then turn OFF. Must be run
      with historyMirror.retainForMigration = true so the PVC outlives the cutover'';
    
    image = mkOption {
      type = types.str;
      default = cfg.agentHost.image;
      description = ''
        The agent-host image (must contain the compiled runEventBackfill.js script and all
        dependencies). Defaults to the same image agent-host uses.
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
    kubernetes.resources.jobs.agent-event-backfill = {
      metadata = { name = "agent-event-backfill"; namespace = ns; };
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
              command = [
                "node"
                "dist/scripts/runEventBackfill.js"
                bcfg.mirrorPath
              ];
              env = [
                {
                  name = "DATABASE_URL";
                  valueFrom.secretKeyRef = {
                    name = cfg.agentHost.databaseSecretName;
                    key = cfg.agentHost.databaseSecretKey;
                  };
                }
                {
                  name = "NODE_ENV";
                  value = "production";
                }
              ];
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
