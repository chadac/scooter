# Resolves enabled contribs' `ui.panel`, `ui.markdownFences` and `ui.views` into the
# manifest's `panels` (by contrib), `markdownFences` (by language) and `views` (by id), and
# throws on a declaration the UI could not load. Lib-only, so examples/check.nix can
# drive it with fixtures.
{ lib }:

let
  checkEntry = where: name: c: entry:
    let check = cond: msg: if cond then true else throw "${where}: ${msg}"; in
    assert check (builtins.match "ui/[^/]+\\.tsx" entry != null)
      "entry \"${entry}\" must be a .tsx file directly in the contrib's ui/ directory";
    assert check (builtins.pathExists (c.src + "/${entry}"))
      "entry \"${entry}\" does not exist in contrib/${name}/";
    "${name}/${entry}";

  panelOf = name: c:
    let
      p = c.ui.panel;
      where = "contribs.${name}.ui.panel";
    in
    assert lib.assertMsg (!p.api || c.services.broker.enable)
      "${where}: api = true relays to this contrib's broker routes, so it needs services.broker.enable";
    {
      contrib = name;
      inherit (p) label order;
      entry = checkEntry where name c p.entry;
    };

  # Paths the UI's nginx proxies (services/ui/image/nginx.nix) or the SPA routes itself. A
  # bare nginx prefix also catches longer ids, so an id may not start with one either.
  reservedPrefixes = [ "agui" "conversations" "sessions" "models" "whoami" "scheduled-tasks" "folders" "user-skills" "users" "remote-agent" ];
  reservedIds = [ "c" "s" "chat" "settings" "contrib" "contrib-api" "telemetry" "healthz" "assets" ];

  viewsOf = name: c: lib.mapAttrsToList
    (id: p:
      let where = "contribs.${name}.ui.views.\"${id}\""; in
      assert lib.assertMsg (builtins.match "[a-z][a-z0-9-]{0,39}" id != null)
        "${where}: the id must match ^[a-z][a-z0-9-]{0,39}$";
      assert lib.assertMsg (!(lib.elem id reservedIds || lib.any (r: lib.hasPrefix r id) reservedPrefixes))
        "${where}: /${id} would shadow a route the app already serves";
      assert lib.assertMsg (!p.api || c.services.broker.enable)
        "${where}: api = true relays to this contrib's broker routes, so it needs services.broker.enable";
      { inherit id; value = { contrib = name; inherit (p) label order; entry = checkEntry where name c p.entry; }; })
    c.ui.views;

  fencesOf = name: c: lib.mapAttrsToList
    (lang: f:
      let where = "contribs.${name}.ui.markdownFences.\"${lang}\""; in
      assert lib.assertMsg (builtins.match "[a-z][a-z0-9-]*" lang != null)
        "${where}: the language must match ^[a-z][a-z0-9-]*$";
      { inherit lang; value = { contrib = name; entry = checkEntry where name c f.entry; }; })
    c.ui.markdownFences;
in

# contribs: the enabled contribs, name -> config.
contribs:
let
  withUi = lib.filterAttrs (_: c: c.ui.enable) contribs;
  fences = lib.concatLists (lib.mapAttrsToList fencesOf withUi);
  owners = lib.foldl' (acc: f: acc // { ${f.lang} = (acc.${f.lang} or [ ]) ++ [ f.value.contrib ]; }) { } fences;
  clashes = lib.filterAttrs (_: cs: lib.length cs > 1) owners;
  viewRows = lib.concatLists (lib.mapAttrsToList viewsOf withUi);
  viewOwners = lib.foldl' (acc: p: acc // { ${p.id} = (acc.${p.id} or [ ]) ++ [ p.value.contrib ]; }) { } viewRows;
  viewClashes = lib.filterAttrs (_: cs: lib.length cs > 1) viewOwners;
in
{
  views =
    if viewClashes != { } then
      throw ("contribs' ui.views: ${lib.concatStringsSep "; " (lib.mapAttrsToList
        (id: cs: "/${id} is claimed by contribs ${lib.concatStringsSep " and " cs}") viewClashes)}")
    else lib.listToAttrs (map (p: lib.nameValuePair p.id p.value) viewRows);
  panels = lib.mapAttrs panelOf (lib.filterAttrs (_: c: c.ui.panel != null) withUi);
  markdownFences =
    if clashes != { } then
      throw ("contribs' ui.markdownFences: ${lib.concatStringsSep "; " (lib.mapAttrsToList
        (l: cs: "\"${l}\" is claimed by contribs ${lib.concatStringsSep " and " cs}") clashes)}")
    else lib.listToAttrs (map (f: lib.nameValuePair f.lang f.value) fences);
}
