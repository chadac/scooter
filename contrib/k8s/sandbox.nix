# k8s's sandbox half: kubectl and helm (nix-stubs shims), and ~/.kube/config rendered
# at boot from the deployment's kubeconfig ConfigMap. Its clusters are forge-proxy
# hosts holding a placeholder token, so the sandbox holds no credential.
{ config, pkgs, lib, ... }:
let
  home = config.programs.scooterCarryOver.home;
  kube = lib.escapeShellArg "${home}/.kube";
in
{
  environment.systemPackages = [ pkgs.kubectl pkgs.kubernetes-helm ];

  # Written only when absent, so a k3d cluster or a context switch survives a restart.
  systemd.services.scooter-k8s-kubeconfig = {
    description = "Render ~/.kube/config from the k8s kubeconfig ConfigMap";
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      src=/etc/scooter/k8s/kubeconfig
      if [ -r "$src" ] && [ ! -e ${kube}/config ]; then
        mkdir -p ${kube}
        install -m 600 "$src" ${kube}/config
        echo "rendered ${home}/.kube/config from $src"
      fi
    '';
  };
}
