# Enabled contribs' static folders, for the router's STATIC_FOLDERS_JSON.
{ lib }:

let
  resolveOne = name: f:
    let
      where = "contribs.${name}.folders (id \"${f.id}\")";
      check = cond: msg: if cond then true else throw "${where}: ${msg}";
    in
    assert check (builtins.match "[a-z][a-z0-9-]{0,62}" f.id != null)
      "the id must match ^[a-z][a-z0-9-]{0,62}$";
    assert check (f.id == name || lib.hasPrefix "${name}-" f.id)
      "the id must be \"${name}\" or start with \"${name}-\", so two contribs never claim one folder";
    { inherit (f) id name; }
    // lib.optionalAttrs (f.icon != null) { inherit (f) icon; }
    // lib.optionalAttrs (f.lifetimeHours != null) { inherit (f) lifetimeHours; };
in

# contribs: the enabled contribs, name -> config.
contribs:
let
  all = lib.concatLists (lib.mapAttrsToList (name: c: map (resolveOne name) c.folders) contribs);
  ids = map (f: f.id) all;
  dupes = lib.unique (lib.filter (i: lib.count (x: x == i) ids > 1) ids);
in
if dupes != [ ] then
  throw "contribs.*.folders: duplicate static folder id ${lib.concatMapStringsSep ", " (d: "\"${d}\"") dupes}"
else all
