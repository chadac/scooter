# brave's sandbox half: the in-pod MCP server exposing `brave_search`.
#
# All of the mechanism is shared (see ../search-mcp/module.nix); brave differs only
# in the broker path it calls and how it reads a result row, both of which live in
# that server. Enabling this contrib is the whole switch — there is no per-provider
# enum to also set, which is the point of each provider being its own contrib.
import ../search-mcp/module.nix {
  provider = "brave";
  toolName = "brave_search";
  displayName = "Search the web (Brave)";
  description = "Ranked web results from Brave Search, proxied through the broker.";
}
