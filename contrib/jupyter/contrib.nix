# JupyterLab, the chat in its sidebar, and jupyter-mcp-server.
{
  contribs.jupyter = {
    src = ./.;
    sandbox.module = ./sandbox.nix;
    skills."scooter-jupyter.md" = ./skills/scooter-jupyter.md;
  };
}
