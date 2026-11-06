# docker's declaration: a nested dockerd for containers and k3d.
{
  contribs.docker = {
    src = ./.;
    sandbox.module = ./sandbox.nix;
    skills."scooter-docker.md" = ./skills/scooter-docker.md;
  };
}
