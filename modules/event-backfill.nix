# ONE-TIME migration: conversation event logs from the history mirror PVC → Postgres.
#
# The event log cutover moved conversation events from the NFS mirror (agent-host-history PVC)
# to Postgres. Deployments that had conversations BEFORE the cutover have their history still
# on the PVC; this Job reads every conversation's events.jsonl from the mirror and loads it
# into Postgres, verifying the row count and checksum chain against what was read from the file.
#
# SAFETY: The Job CANNOT run unless retainForMigration = true (enforced by assertion). This
# prevents the PVC from being deleted mid-backfill. The correct sequence is:
#   1. retainForMigration = true (deploy)  → PVC stays provisioned
#   2. eventBackfill.enable = true (deploy) → Job runs
#   3. kubectl logs -f job/agent-event-backfill → verify ok=true for ALL conversations
#   4. eventBackfill.enable = false (deploy) → Job removed
#   5. retainForMigration = false (deploy) → PVC reclaimed
#
# EPHEMERAL: run it ONCE during the cutover, verify the report shows every conversation OK,
# then turn it OFF. The Job is idempotent (backfillConversation skips rows already present),
# so a re-run only loads what's missing.
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
      historyMirror.retainForMigration = true (enforced by assertion) so the PVC cannot be
      deleted while the backfill is running'';
    
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

  config = lib.mkMerge [
    # SAFETY ASSERTION: the backfill Job CANNOT run unless the PVC is retained. Without this,
    # an operator could accidentally delete the PVC (retainForMigration = false) while the Job
    # is still running, destroying the only copy of history the backfill hadn't yet loaded.
    (lib.mkIf bcfg.enable {
      assertions = [
        {
          assertion = hmCfg.retainForMigration;
          message = ''
            eventBackfill.enable requires historyMirror.retainForMigration = true.
            
            The backfill Job reads conversation history FROM the PVC, so the PVC must stay
            provisioned while the Job runs. Set retainForMigration = true BEFORE enabling
            the backfill, then set it back to false AFTER the backfill reports success.
            
            Safe sequence:
              1. historyMirror.retainForMigration = true  (deploy)
              2. eventBackfill.enable = true              (deploy)
              3. kubectl logs -f job/agent-event-backfill (verify ok=true)
              4. eventBackfill.enable = false             (deploy)
              5. historyMirror.retainForMigration = false (deploy)
          '';
        }
      ];
    })

    (lib.mkIf bcfg.enable {
      kubernetes.resources.jobs.agent-event-backfill = {
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
    })
  ];
}
