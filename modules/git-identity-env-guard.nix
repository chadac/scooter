# Git ranks this env above the broker's identity, so reject it.
{ lib }:

where: env:
let
  bad = lib.filter (e: builtins.match "GIT_(AUTHOR|COMMITTER)_.*" (e.name or "") != null) env;
in
if bad == [ ] then env
else throw ''
  ${where} sets ${lib.concatMapStringsSep ", " (e: e.name) bad} on the sandbox.
  Git ranks these above the commit identity the sandbox polls from the broker
  (GET /git/identity, see modules/sandbox-os/git-identity.nix), so the owner's
  private conversations would commit as whoever is named here. Remove them:
  the broker already names the bot wherever the bot should author.
''
