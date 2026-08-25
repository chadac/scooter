{ lib, buildGoModule, ... }:

# The conversation router (Go). Fronts the agent-host Service and reverse-proxies each
# request to the agent-host pod that owns the conversation (status.hostPod). Go so a
# single httputil.ReverseProxy handles HTTP + SSE + WebSocket uniformly (the /c/<id>/
# web-service proxy is WS). See todo/docs/CONVERSATION_CRD_PR1.md.

buildGoModule {
  pname = "conversation-router";
  version = "0.0.0";
  src = ./.;

  vendorHash = "sha256-XVG4RIveHsv75eCSY/it4ix7mleeGJyV6i3QVIwoh/4=";

  # Static-ish; no cgo needed.
  env.CGO_ENABLED = "0";

  meta.description = "Scooter conversation router (hostPod reverse-proxy)";
}
