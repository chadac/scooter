# One-time migration Job that loads every conversation's events.jsonl from the
# history mirror PVC into Postgres, verifying row count and checksum chain per
# conversation. It renders only while retainForMigration = true so the PVC stays
# provisioned for the whole run, and the load is not idempotent, so a partial run
# must be truncated before a retry. The loader is
# services/agent-host/src/session/eventBackfill.ts.

{ config, lib, ... }:

let
  cfg = config.scooter;
  bcfg = cfg.eventBackfill;
  ns = cfg.namespace;

  hmCfg = cfg.conversationController.historyMirror;
in
{
  options.scooter.eventBackfill = with lib; {
    enable = mkEnableOption ''
      the one-shot event backfill Job (history mirror PVC → Postgres). Turn ON to run the
      migration, verify the report shows all conversations OK, then turn OFF. REQUIRES
      historyMirror.retainForMigration = true (enforced by an eval-time assert) so the PVC
      cannot be deleted while the backfill is running'';

    image = mkOption {
      type = types.str;
      default = cfg.agentHostImage;
      defaultText = literalExpression "config.scooter.agentHostImage";
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
    # An eval-time `assert` on the resource value (wrapping `config` itself would recurse) because kubenix has no `assertions` option.
    kubernetes.resources.jobs.agent-event-backfill =
      assert lib.assertMsg hmCfg.retainForMigration ''
        scooter.eventBackfill.enable = true requires
        scooter.conversationController.historyMirror.retainForMigration = true.

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
          template = cfg.imageless.wrapPod "agent-host" "backfill" {
            metadata.labels = {
              app = "agent-event-backfill";
              "app.kubernetes.io/name" = "agent-event-backfill";
              "app.kubernetes.io/component" = "migration";
            };
            spec = {
              restartPolicy = "OnFailure";
              # The agent-host service account, for the db secrets.
              serviceAccountName = "agent-host";
              securityContext = {
                fsGroup = 0;
                fsGroupChangePolicy = "OnRootMismatch";
              };
              containers.backfill = {
                name = "backfill";
                image = bcfg.image;
                imagePullPolicy = cfg.pullPolicy;
                # The packaged bin shim runs from any CWD, which the image does not set.
                command = [
                  "agent-host-backfill"
                  bcfg.mirrorPath
                ];
                # The same AGENT_HOST_DB_* wiring agent-host itself uses, assembled into a DSN by runEventBackfill.js.
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
