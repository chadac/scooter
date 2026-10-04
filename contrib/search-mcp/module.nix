# Shared sandbox half for the search contribs (brave, kagi).
#
# NOT a contrib itself — this directory has no default.nix, so
# check-contrib-coverage.sh does not count it and all-modules.nix does not import
# it. It is a function the search contribs' own sandbox.nix files call, because
# two providers differing only in a broker path and a result shape should not be
# two copies of an MCP server.
#
# Returns a NixOS module declaring one `mcpServers.<provider>` entry. The server
# talks to the vendor THROUGH THE BROKER (see server.py), so no API key is ever
# present in the sandbox — which is also why this needs no secret plumbing of its
# own and why enabling it is purely a source-tree decision.
{ provider, toolName, displayName, description }:

{ pkgs, ... }:

{
  mcpServers.${provider} = {
    enable = true;
    inherit displayName description;

    # stdio, not `command`: the module bridges it to streamable HTTP with mcp-proxy
    # for us, so the server stays a ~200-line stdin/stdout script with no HTTP
    # framework and no port of its own to get wrong.
    stdioCommand = "${pkgs.python3}/bin/python3 ${./server.py}";

    # autoStart so search is available on the agent's FIRST message. A lazily
    # started search tool is one the agent does not know it has.
    autoStart = true;

    environment = {
      SEARCH_PROVIDER = provider;
      SEARCH_TOOL_NAME = toolName;
      SEARCH_TOOL_TITLE = displayName;
    };
  };
}
