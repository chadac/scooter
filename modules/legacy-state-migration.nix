# ONE-TIME migration: legacy per-pod RWO conversation state → the shared history mirror.
#
# The rollout-drain work moved agent-host storage from a per-pod RWO PVC
# (`state-agent-host-<n>`, StatefulSet era) to an emptyDir hot cache + a shared RWX mirror
# (`agent-host-history`). A user upgrading in place has all their conversation history on the
# OLD RWO PVCs; after the switch to emptyDir those pods start empty and the mirror is new/empty,
# so the legacy conversations are STRANDED (not on the mirror → never revivable → invisible +
# unreachable). This renders a one-shot Job that copies each legacy PVC's `conversations/` tree
# into the mirror's `conversations/` (identical on-disk format, just a different volume).
#
# EPHEMERAL: run it once during the cutover (agent-host scaled to 0 so nothing writes the old
# PVCs mid-copy), verify, then set the flag back off (and later delete the old PVCs). It is
# idempotent (cp -an = no-clobber), so a re-run only copies what's missing.
#
# See todo/docs/LEGACY_CONVERSATION_MIGRATION.md.

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  mcfg = cfg.legacyStateMigration;
  ns = cfg.namespace;

  # Mount each legacy RWO PVC read-only at /legacy/<pvc>, and the shared mirror rw at /mirror.
  # For each, copy conversations/* into the mirror (no-clobber so a conv already on the mirror —
  # e.g. one that went live during a partial migration — is never overwritten with older data).
  # NOTE: busybox `cp` does NOT support the GNU `cp -a src/. dst/` contents-copy idiom (it
  # silently no-ops), so copy each conversation DIR by glob. -a preserves; we skip a conversation
  # already on the mirror (no-clobber) by testing existence first (busybox `cp -n` is unreliable).
  copyScript = ''
    set -eu
    mkdir -p /mirror/conversations
    copied=0; skipped=0
    for src in ${lib.concatStringsSep " " (map (p: "/legacy/${p}") mcfg.legacyPvcs)}; do
      if [ ! -d "$src/conversations" ]; then
        echo ">> $src has no conversations/ dir — skipping"
        continue
      fi
      echo ">> $src/conversations: $(ls "$src/conversations" 2>/dev/null | wc -l) conversation(s)"
      for conv in "$src"/conversations/*; do
        [ -d "$conv" ] || continue
        name=$(basename "$conv")
        if [ -e "/mirror/conversations/$name" ]; then
          skipped=$((skipped + 1)) # already on the mirror (e.g. it went live during migration)
        else
          cp -a "$conv" /mirror/conversations/
          copied=$((copied + 1))
        fi
      done
    done
    echo ">> migration done. copied=$copied skipped=$skipped; mirror now has $(ls /mirror/conversations 2>/dev/null | wc -l) conversation(s)."
  '';
in
{
  options.agentSandbox.legacyStateMigration = with lib; {
    enable = mkEnableOption ''
      the one-shot legacy-state migration Job (old per-pod RWO PVCs -> shared mirror). Turn ON for
      the cutover, run once (with agent-host scaled to 0), then turn OFF. See the module header'';
    legacyPvcs = mkOption {
      type = types.listOf types.str;
      default = [ "state-agent-host-0" "state-agent-host-1" ];
      example = [ "state-agent-host-0" "state-agent-host-1" "state-agent-host-2" ];
      description = ''
        The legacy StatefulSet per-pod RWO PVC names to migrate FROM (named
        `state-agent-host-<ordinal>` by the old volumeClaimTemplate). Each is mounted read-only
        and its `conversations/` tree copied into the mirror. List all that existed.
      '';
    };
    image = mkOption {
      type = types.str;
      default = "busybox:1.36";
      description = "A tiny image with a POSIX shell + cp (busybox) for the copy Job.";
    };
  };

  config = lib.mkIf mcfg.enable {
    kubernetes.resources.jobs.agent-legacy-state-migration = {
      metadata = { name = "agent-legacy-state-migration"; namespace = ns; };
      spec = {
        backoffLimit = 2;
        template.spec = {
          restartPolicy = "OnFailure";
          # fsGroup 0 so the copy can read the RWO PVCs (owned root:root, like the state PVC was).
          securityContext = { fsGroup = 0; fsGroupChangePolicy = "OnRootMismatch"; };
          containers.copy = {
            name = "copy";
            image = mcfg.image;
            command = [ "/bin/sh" "-c" copyScript ];
            volumeMounts =
              (map (p: { name = p; mountPath = "/legacy/${p}"; readOnly = true; }) mcfg.legacyPvcs)
              ++ [{ name = "mirror"; mountPath = "/mirror"; }];
          };
          volumes =
            (map (p: { name = p; persistentVolumeClaim = { claimName = p; readOnly = true; }; }) mcfg.legacyPvcs)
            ++ [{ name = "mirror"; persistentVolumeClaim.claimName = "agent-host-history"; }];
        };
      };
    };
  };
}
