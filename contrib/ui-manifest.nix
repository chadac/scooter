# Generates the UI's contrib manifest: the metadata every enabled contrib
# contributes to the frontend, as ONE JSON document the UI fetches at RUNTIME.
#
# Runtime, not compiled in, for the same reason /telemetry/config.json is: the UI
# image is built once and deployed to clusters whose contrib set differs, so a
# deployment changing that set must not mean recompiling the bundle. nginx serves
# it at /contrib/manifest.json from the UI image (pkgs/ui-image). Overriding it per
# deployment needs no platform.nix option: a contrib is a module, so it can mkIf a
# ConfigMap into the platform render itself.
#
# That is only possible because an icon is DATA here — a viewBox plus a single
# path, read out of the contrib's own .svg — rather than a React component. A
# component could only be resolved from a runtime name by bundling a whole
# react-icons pack (~4.9 MB). Why: PR #601.
{ lib, writeText }:

let
  # Simple Icons ship one path per mark, so two attributes are the whole icon.
  # A throw here rather than a broken glyph in the browser: the contrib's SVG is
  # a repo file, so a malformed one is an author error, catchable at eval.
  iconData = name: file:
    let
      svg = builtins.readFile file;
      viewBox = builtins.match ''.*viewBox="([^"]+)".*'' svg;
      path = builtins.match ''.*<path[^>]*d="([^"]+)".*'' svg;
    in
    if viewBox == null || path == null
    then throw "contrib ${name}: ${toString file} must be an SVG with a viewBox and a single <path d=…> (see contrib/README.md)"
    else { viewBox = lib.head viewBox; path = lib.head path; };
in

contribs:

let
  withUi = lib.filterAttrs (_: c: c.ui.enable) contribs;
  sourced = lib.filterAttrs (_: c: c.ui.source != null) withUi;

  sources = lib.mapAttrs
    (name: c: {
      inherit (c.ui.source) label color linkProvider;
      icon = iconData name c.ui.source.icon;
    })
    sourced;

  # Keyed by the tool NAME (the stable identity the UI normalizes an incoming ACP
  # tool call down to). `provider` is the contrib name, so the card picks up that
  # contrib's source row.
  toolCards = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
    (name: c: lib.mapAttrsToList
      (tool: t: lib.nameValuePair tool { provider = name; inherit (t) argKey action; })
      c.ui.tools)
    withUi));

  # Lowercased: the UI matches a registerTool title case-insensitively.
  toolTitles = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
    (_: c: lib.concatLists (lib.mapAttrsToList
      (tool: t: map (title: lib.nameValuePair (lib.toLower title) tool) t.titles)
      c.ui.tools))
    withUi));

  linkProviders = lib.attrNames (lib.filterAttrs (_: c: c.ui.source.linkProvider) sourced);
in

writeText "contrib-manifest.json" (builtins.toJSON {
  inherit sources toolCards toolTitles linkProviders;
})
