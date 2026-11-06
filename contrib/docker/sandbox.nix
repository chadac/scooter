# docker's sandbox half: dockerd in nested namespaces, socket-activated on /run/docker.sock.

{ config, lib, pkgs, ... }:

let
  run = "/run/scooter-docker";
  sock = "/run/docker.sock";
  dataRoot = "/workspace/.scooter/docker";
  shimPort = "3128";
  # TEST-NET-1: unrouted, so every container network reaches it locally.
  proxyIp = "192.0.2.1";
  containerProxy = "http://${proxyIp}:${shimPort}";

  outer = pkgs.writeShellScript "scooter-dockerd" ''
    set -eu
    # A masked /proc (host-user pods) breaks container sysctls and networking.
    case "$(findmnt -rno OPTIONS /proc/sys || true)" in ro*)
      echo "scooter-docker: /proc/sys is read-only; docker needs sandboxUserNamespace (procMount: Unmasked)" >&2
      exit 1 ;;
    esac
    # Materialize the stubs here, where the nix cache is reachable.
    ${pkgs.docker}/bin/dockerd --version >/dev/null
    ${pkgs.crun}/bin/crun --version >/dev/null
    # Map every pod ID, so image files keep their owners.
    ids=$(awk '{ n += $3 } END { print n }' /proc/self/uid_map)
    exec unshare -U -n -m --propagation private \
      --map-users=0:0:"$ids" --map-groups=0:0:"$ids" ${inner}
  '';

  # Runs as the namespaces' first process, then becomes dockerd.
  inner = pkgs.writeShellScript "scooter-dockerd-inner" ''
    set -eu
    ip link set lo up
    # Nameservers only: pod search domains break node-name lookups.
    grep '^nameserver' /etc/resolv.conf > ${run}/resolv.conf
    mount --bind ${run}/resolv.conf "$(readlink -f /etc/resolv.conf)"
    ip link add scooter-proxy type dummy
    ip addr add ${proxyIp}/32 dev scooter-proxy
    ip link set scooter-proxy up
    socat TCP-LISTEN:${shimPort},bind=0.0.0.0,reuseaddr,fork UNIX-CONNECT:${run}/proxy.sock &
    mkdir -p ${dataRoot}
    exec ${pkgs.docker}/bin/dockerd -H fd:// --data-root ${dataRoot} \
      --storage-driver overlay2 \
      --add-runtime scooter-crun=${crunWrap} --default-runtime scooter-crun
  '';

  # Nested sysfs mounts are refused as too revealing; bind /sys.
  crunWrap = pkgs.writeShellScript "scooter-crun" ''
    bundle=""; prev=""
    for a in "$@"; do
      case "$prev" in --bundle|-b) bundle="$a" ;; esac
      case "$a" in --bundle=*) bundle="''${a#--bundle=}" ;; esac
      prev="$a"
    done
    cfg="$bundle/config.json"
    if [ -n "$bundle" ] && [ -f "$cfg" ]; then
      ${lib.getExe pkgs.jq} '.mounts |= map(if .type == "sysfs" then
          {destination, type: "bind", source: "/sys", options: ["rbind", "nosuid", "noexec", "nodev"]}
        else . end)' "$cfg" > "$cfg.scooter" && mv "$cfg.scooter" "$cfg"
    fi
    exec ${pkgs.crun}/bin/crun "$@"
  '';

  # `k3d cluster create` defaults that make a cluster work in here.
  k3d = pkgs.writeShellScriptBin "k3d" ''
    export DOCKER_HOST=''${DOCKER_HOST:-unix://${sock}}
    real=${pkgs.k3d}/bin/k3d
    if [ "''${1:-}" != cluster ] || [ "''${2:-}" != create ]; then exec "$real" "$@"; fi
    shift 2
    # CONTAINERD_*: image pulls use the proxy; node traffic stays direct.
    exec "$real" cluster create "$@" --volume /dev/null:/dev/kmsg@all \
      -e CONTAINERD_HTTPS_PROXY=${containerProxy}@all -e CONTAINERD_HTTP_PROXY=${containerProxy}@all \
      -e CONTAINERD_NO_PROXY=localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.cluster.local@all
  '';

  # Run a command in dockerd's network, beside published ports.
  dockerNetns = pkgs.writeShellScriptBin "docker-netns" ''
    set -eu
    export DOCKER_HOST=''${DOCKER_HOST:-unix://${sock}}
    # Starts dockerd through its socket if it is not running.
    ${pkgs.docker}/bin/docker info >/dev/null
    pid=$(systemctl show -P MainPID scooter-docker.service)
    # Local and bridge addresses here must bypass the proxy.
    no_proxy="''${no_proxy:-''${NO_PROXY:-}},0.0.0.0,172.16.0.0/12,192.168.0.0/16"
    export no_proxy NO_PROXY="$no_proxy"
    exec nsenter -t "$pid" -n -- "$@"
  '';
in
{
  environment.systemPackages = [
    (lib.hiPrio k3d)
    pkgs.docker
    pkgs.kubectl
    pkgs.socat
    dockerNetns
  ];

  # Clients default to /var/run, not linked to /run here.
  environment.variables.DOCKER_HOST = "unix://${sock}";
  # Opt-in per container: injecting it would proxy calls between containers.
  environment.variables.SCOOTER_CONTAINER_PROXY = containerProxy;

  systemd.sockets.scooter-docker = {
    description = "Nested dockerd socket";
    wantedBy = [ "sockets.target" ];
    listenStreams = [ sock ];
    socketConfig.SocketMode = "0660";
  };

  # Pod side of the proxy bridge: unix socket to forge shim.
  systemd.services.scooter-docker-proxy = {
    description = "Forge shim bridge for the nested dockerd";
    wants = [ "scooter-forge-shim.service" ];
    after = [ "scooter-forge-shim.service" ];
    serviceConfig = {
      ExecStart = "${lib.getExe pkgs.socat} UNIX-LISTEN:${run}/proxy.sock,fork,unlink-early TCP:127.0.0.1:${shimPort}";
      RuntimeDirectory = "scooter-docker";
      RuntimeDirectoryPreserve = true;
      Restart = "always";
    };
  };

  systemd.services.scooter-docker = {
    description = "Docker in nested user, network and mount namespaces";
    requires = [ "scooter-docker.socket" "scooter-docker-proxy.service" ];
    after = [ "scooter-docker.socket" "scooter-docker-proxy.service" ];
    # The stubs materialize through nix-store.
    path = with pkgs; [ config.nix.package util-linux iproute2 socat gawk gnugrep coreutils ];
    environment = {
      HTTPS_PROXY = "http://127.0.0.1:${shimPort}";
      HTTP_PROXY = "http://127.0.0.1:${shimPort}";
      NO_PROXY = "localhost,127.0.0.1";
    };
    serviceConfig = {
      ExecStart = outer;
      Delegate = true;
      KillMode = "mixed";
      LimitNOFILE = 1048576;
      TasksMax = "infinity";
      Restart = "on-failure";
      RuntimeDirectory = "scooter-docker";
      RuntimeDirectoryPreserve = true;
    };
  };
}
