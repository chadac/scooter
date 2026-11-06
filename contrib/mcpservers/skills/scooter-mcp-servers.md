# MCP servers from Settings (scooter-mcp-servers)

The user can list MCP servers in Settings → MCP servers: an **npm** package (run with
`npx -y`), a **PyPI** package (run with `uv tool run`) or a **nixpkgs** attribute (run
with `nix run`), each with optional arguments. Every sandbox of theirs starts them, and
their tools reach you as `mcp__sandbox-<name>__<tool>` from the next message after one
is running.

- **Commands.** `scooter-mcp-servers list` shows each server, its state and the last
  sync. `scooter-mcp-servers sync` applies a Settings change now instead of within two
  minutes.
- **A failing server.** Each runs as the unit `mcp-user@<name>`, so read
  `journalctl -u mcp-user@<name>`. Its first start can take a minute while the package
  downloads.
- **Names.** A server declared in your environment (`mcpServers.<name>`) wins over one
  from Settings with the same name.
- **No secrets yet.** There's no way to give these servers an API key. Don't ask the user
  to paste one into the arguments, since you can read anything in the sandbox.
