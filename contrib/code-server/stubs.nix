{ pkgs }:
{
  # The prebuilt release, not nixpkgs: the VS Code agent-host bridge needs VS Code >= 1.141.
  code-server = pkgs.callPackage ./code-server-bin { };

  # The Agent Host Protocol server code-server bridges to (./sandbox.nix).
  scooter-vscode-ahp = pkgs.callPackage ./ahp { };
}
