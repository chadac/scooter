# Platform NetworkPolicies: the in-namespace network wall.
#
# - Sandboxes reach only the broker, forge proxy, router self-access, DNS and the internet.
# - Only the agent-host and router reach a sandbox; only the agent-host reaches its MCP ports.
# - Only the router and conversation-controller reach agent-host pods.
# - Only the agent-host reaches the BYOC controller's internal port.
#
# Needs a CNI that enforces NetworkPolicy; elsewhere these are inert.

{ config, lib, ... }:

let
  cfg = config.scooter;
  npcfg = cfg.networkPolicy;
  ccfg = cfg.conversationController;

  # The agent-sandbox controller sets this on every sandbox pod and strips any agents.x-k8s.io/*
  # label from the pod template, so the provisioner's own sandbox-name label never reaches the pod.
  sandboxLabel = "agents.x-k8s.io/sandbox-name-hash";
  isSandbox = { matchExpressions = [{ key = sandboxLabel; operator = "Exists"; }]; };

  tcp = port: { protocol = "TCP"; inherit port; };
  udp = port: { protocol = "UDP"; inherit port; };
  anyPorts = map udp npcfg.udpPorts ++ map tcp npcfg.tcpPorts;

  # The router carries web services, never MCP, so it gets every port outside the MCP range.
  mcpPorts = import ./sandbox-os/mcp-port-range.nix;
  tcpRange = port: endPort: { protocol = "TCP"; inherit port endPort; };
  notMcpPorts = [ (tcpRange 1 (mcpPorts.first - 1)) (tcpRange (mcpPorts.last + 1) 65535) ];

  # Named container ports, so a port change in the owning module cannot drift from here.
  brokerPorts = [ (tcp "http") (tcp "forge-proxy") ];
in
{
  options.scooter.networkPolicy = with lib; {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Render the NetworkPolicies that isolate sandbox pods and admit only the
        router and conversation-controller to agent-host pods. Disable only if you
        supply equivalent policies yourself: without them a sandbox can reach the
        agent-host, router and Postgres directly and impersonate any user.
      '';
    };
    internetExcept = mkOption {
      type = types.listOf types.str;
      default = [
        "0.0.0.0/8"
        "10.0.0.0/8"
        "100.64.0.0/10" # CGNAT, which includes Tailscale addresses
        "127.0.0.0/8"
        "169.254.0.0/16" # link-local, which includes cloud metadata endpoints
        "172.16.0.0/12"
        "192.168.0.0/16"
      ];
      description = ''
        IPv4 ranges excluded from the sandbox's "internet" egress rule. They must cover
        the pod, Service and node CIDRs, or a sandbox can reach in-cluster services
        directly. Extend this if your cluster uses public address space internally.
      '';
    };
    udpPorts = mkOption {
      type = types.listOf types.port;
      default = [ 53 ];
      example = [ 53 10053 ];
      description = ''
        UDP ports the sandbox may reach at any destination, including in-cluster
        addresses. The default allows DNS. The policy is evaluated after kube-proxy's
        DNAT, so list the resolver pods' *target* port, not the Service port (NixOS's
        coredns addon listens on 10053).
      '';
    };
    tcpPorts = mkOption {
      type = types.listOf types.port;
      default = [ 53 ];
      example = [ 53 10053 ];
      description = ''
        TCP ports the sandbox may reach at any destination, including in-cluster
        addresses. The default allows DNS over TCP. See `udpPorts` for the DNAT caveat.
      '';
    };
    extraEgress = mkOption {
      type = types.listOf types.attrs;
      default = [ ];
      example = lib.literalExpression ''
        [ { to = [ { ipBlock.cidr = "10.0.5.20/32"; } ]; ports = [ { protocol = "TCP"; port = 443; } ]; } ]
      '';
      description = "Extra NetworkPolicy egress rules for sandbox pods, e.g. an in-network Nix cache.";
    };
    sandboxExtraIngress = mkOption {
      type = types.listOf types.attrs;
      default = [ ];
      example = lib.literalExpression ''
        [ { from = [ { podSelector.matchLabels.app = "metrics-scraper"; } ]; ports = [ { protocol = "TCP"; port = 9100; } ]; } ]
      '';
      description = ''
        Extra NetworkPolicy ingress rules for sandbox pods. By default only the agent-host
        may connect, plus the conversation router on every port outside the MCP server
        range (9700-9799). That rule uses `endPort`, which the CNI must support (k3s's
        kube-router, Calico and Cilium do). Keep extra rules off the MCP range: those
        servers are unauthenticated and trust whoever reaches them.
      '';
    };
    agentHostExtraIngress = mkOption {
      type = types.listOf types.attrs;
      default = [ ];
      example = lib.literalExpression ''
        [ { from = [ { podSelector.matchLabels.app = "metrics-scraper"; } ]; ports = [ { protocol = "TCP"; port = 8080; } ]; } ]
      '';
      description = ''
        Extra NetworkPolicy ingress rules for agent-host pods. By default only the
        conversation router and conversation-controller may connect; every other
        caller goes through the router, which authenticates it.
      '';
    };
  };

  config = lib.mkIf npcfg.enable {
    # The internal port trusts the identity the caller names.
    kubernetes.resources.networkPolicies.byoc-controller-ingress = lib.mkIf cfg.byoc.enable {
      metadata = { name = "byoc-controller-ingress"; namespace = cfg.namespace; };
      spec = {
        podSelector.matchLabels."app.kubernetes.io/name" = "byoc-controller";
        policyTypes = [ "Ingress" ];
        ingress = [
          { from = [{ podSelector.matchLabels.app = "agent-host"; }]; }
          { ports = [ (tcp "public") ]; }
        ];
      };
    };

    kubernetes.resources.networkPolicies.sandbox-isolation = {
      metadata = { name = "sandbox-isolation"; namespace = cfg.namespace; };
      spec = {
        podSelector = isSandbox;
        policyTypes = [ "Ingress" "Egress" ];

        # The agent-host and router dial the pod IP directly; nothing else needs to.
        ingress = [
          { from = [{ podSelector.matchLabels.app = "agent-host"; }]; }
          { from = [{ podSelector.matchLabels.app = "conversation-router"; }]; ports = notMcpPorts; }
        ] ++ npcfg.sandboxExtraIngress;

        egress =
          # Any destination: NodeLocal DNSCache's host-network IP matches no podSelector.
          # Skipped when empty: a rule with no ports allows everything.
          lib.optional (anyPorts != [ ]) { ports = anyPorts; }
          ++ [{
            to = [{ ipBlock = { cidr = "0.0.0.0/0"; except = npcfg.internetExcept; }; }];
          }]
        ++ lib.optional cfg.broker.enable {
          to = [{ podSelector.matchLabels.app = "agent-broker"; }];
          ports = brokerPorts;
        }
        ++ lib.optional ccfg.selfAccess.enable {
          to = [{ podSelector.matchLabels.app = "conversation-router"; }];
          ports = [ (tcp "self") ];
        }
        ++ npcfg.extraEgress;
      };
    };

    # Agent-host trusts identity headers, so only the router that sets them connects.
    kubernetes.resources.networkPolicies.agent-host-ingress = {
      metadata = { name = "agent-host-ingress"; namespace = cfg.namespace; };
      spec = {
        podSelector.matchLabels.app = "agent-host";
        policyTypes = [ "Ingress" ];
        ingress = [{
          from = [
            { podSelector.matchLabels.app = "conversation-router"; }
            # Revive pushes dial the newly assigned pod's IP directly.
            { podSelector.matchLabels.app = "conversation-controller"; }
          ];
        }] ++ npcfg.agentHostExtraIngress;
      };
    };
  };
}
