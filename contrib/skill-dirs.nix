# The enabled contribs' skill DIRECTORIES (`contribs.<name>.skillDirs`), resolved to
# store paths. Lib-only, so the kubenix eval and the image build share it: an
# in-repo `path` is copied as-is, and a `source` is fetched from the commit pinned in
# ./skills.lock (refresh it with `just lock-skills`). The in-pod re-converge never
# calls this, since it would have no network; it reads the copies baked into the
# vendored tree (modules/sandbox-os/runtime-converge/reconverge-inputs.nix).
{ lib, contribs, lock ? lib.importJSON ./skills.lock }:

let
  enabled = lib.filterAttrs (_: c: c.enable && c.skillDirs != { }) contribs;

  # One skill directory as a store path named for the skill, so the image and the
  # vendored copy in the pod (same content, same name) land on the same path.
  resolve = contrib: name: s:
    if builtins.match "[A-Za-z0-9][A-Za-z0-9._-]*" name == null then
      throw "contribs.${contrib}.skillDirs.\"${name}\": a skill name is a directory and file name, so only letters, digits, '.', '_' and '-'."
    else
    let
      key = "${contrib}/${name}";
      entry = lock.${key} or (throw ''
        contribs.${contrib}.skillDirs.${name}: no entry "${key}" in contrib/skills.lock.
        Run `just lock-skills` to pin it.'');
      root =
        if s.path != null && s.source == null then s.path
        else if s.source != null && s.path == null then
          if entry.source != s.source || entry.dir != s.dir then
            throw ''
              contribs.${contrib}.skillDirs.${name}: contrib/skills.lock pins
              ${entry.source} (dir "${entry.dir}"), but the contrib declares
              ${s.source} (dir "${s.dir}"). Run `just lock-skills`.''
          else
            let tree = builtins.fetchTree {
              type = "github";
              inherit (entry) owner repo rev narHash;
            }; in
            if s.dir == "" then tree.outPath else "${tree.outPath}/${s.dir}"
        else throw "contribs.${contrib}.skillDirs.${name}: set exactly one of `path` or `source`.";
      src = builtins.path { path = root; name = "skill-${name}"; };
    in
    if !(builtins.pathExists "${src}/SKILL.md")
    then throw "contribs.${contrib}.skillDirs.${name}: ${if s.source != null then s.source else toString s.path} has no SKILL.md."
    else { inherit contrib src; };

  perContrib = lib.mapAttrsToList
    (contrib: c: lib.mapAttrs (resolve contrib) c.skillDirs)
    enabled;

  # Skill names are what the agent sees, so they are global, like tool names.
  merged = lib.foldl'
    (acc: dirs: lib.foldl'
      (a: name:
        if a ? ${name} then
          throw "skill directory \"${name}\" is declared by both contribs.${a.${name}.contrib} and contribs.${dirs.${name}.contrib}."
        else a // { ${name} = dirs.${name}; })
      acc (lib.attrNames dirs))
    { } perContrib;
in
merged
