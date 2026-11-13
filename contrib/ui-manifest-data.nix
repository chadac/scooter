# The UI's contrib manifest as data: the metadata every enabled contrib contributes
# to the frontend. Lib-only, so both the UI image (ui-manifest.nix, from the build's
# contrib list) and the platform (modules/platform.nix, from the deployment's list,
# which is what nginx serves when mounted) render it. An icon is data here (a viewBox
# plus a single path read from the contrib's .svg), not a component. Takes the
# ENABLED contribs only: a disabled contrib must contribute nothing, tabs included.
{ lib }:

let
  resolveSettingsTabs = import ./settings-tabs.nix { inherit lib; };
  resolveInterruptRenderers = import ./interrupt-renderers.nix { inherit lib; };
  resolveConversationUi = import ./conversation-ui.nix { inherit lib; };

  # A malformed SVG is an author error, so it throws at eval rather than rendering a broken glyph.
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
  # `ui.source` keyed by contrib name, plus each `ui.sources` row.
  sourceRows = lib.concatLists (lib.mapAttrsToList
    (name: c:
      lib.optional (c.ui.source != null) { id = name; owner = name; row = c.ui.source; }
      ++ lib.mapAttrsToList
        (id: row:
          if lib.hasPrefix "${name}-" id then { inherit id row; owner = name; }
          else throw "contribs.${name}.ui.sources.${id}: a source id must start with \"${name}-\"")
        c.ui.sources)
    withUi);

  sourceIds = map (r: r.id) sourceRows;
  sourceDups = lib.unique (lib.filter (id: lib.count (x: x == id) sourceIds > 1) sourceIds);

  sources =
    if sourceDups != [ ] then throw "contribs' ui.source/ui.sources: duplicate source ids ${lib.concatStringsSep ", " sourceDups}"
    else lib.listToAttrs (map
      (r: lib.nameValuePair r.id {
        inherit (r.row) label color linkProvider;
        icon = iconData r.owner r.row.icon;
      })
      sourceRows);

  # Keyed by the tool name the UI normalizes an incoming ACP tool call down to; `provider` selects the contrib's source row.
  toolCards = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
    (name: c: lib.mapAttrsToList
      (tool: t:
        if t.source != null && !(sources ? ${t.source})
        then throw "contribs.${name}.ui.tools.${tool}.source: no source row \"${t.source}\""
        else lib.nameValuePair tool { provider = if t.source != null then t.source else name; inherit (t) argKey action; })
      c.ui.tools)
    withUi));

  # Lowercased: the UI matches a registerTool title case-insensitively.
  toolTitles = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
    (_: c: lib.concatLists (lib.mapAttrsToList
      (tool: t: map (title: lib.nameValuePair (lib.toLower title) tool) t.titles)
      c.ui.tools))
    withUi));

  linkProviders = lib.attrNames (lib.filterAttrs (_: s: s.linkProvider) sources);

  # Keyed by tab id; validated (and thrown on) in settings-tabs.nix.
  settingsTabs = resolveSettingsTabs contribs;

  # Keyed by request kind; validated (and thrown on) in interrupt-renderers.nix.
  interruptRenderers = resolveInterruptRenderers contribs;

  # Public path prefix -> the contribs claiming it. nginx reads this list off the
  # manifest it serves, so the deployment's mounted copy decides what it proxies.
  publicPathOwners = lib.foldl' (acc: { name, path }: acc // { ${path} = (acc.${path} or [ ]) ++ [ name ]; }) { }
    (lib.concatLists (lib.mapAttrsToList
      (name: c: map (path: { inherit name path; })
        (if c.services.broker.enable then c.services.broker.publicPaths else [ ]))
      contribs));
  publicPathClashes = lib.filterAttrs (_: cs: lib.length cs > 1) publicPathOwners;
  brokerPublicPaths =
    if publicPathClashes != { } then
      throw ("contribs' services.broker.publicPaths: ${lib.concatStringsSep "; " (lib.mapAttrsToList
        (p: cs: "\"${p}\" is claimed by contribs ${lib.concatStringsSep " and " cs}") publicPathClashes)}")
    else lib.attrNames publicPathOwners;

  # Keyed as conversation-ui.nix resolves them.
  inherit (resolveConversationUi contribs) panels linkViews markdownFences markdownSyntax views;

  # The presentation half of each contrib's approval gate, not gated on `ui.enable` because a contrib may raise approvals while contributing no icon.
  approvals = lib.mapAttrs
    (_: c: { inherit (c.approvals) gatedOption blockedTitle blockedHint; })
    (lib.filterAttrs (_: c: c.approvals != null) contribs);
in
{ inherit sources toolCards toolTitles linkProviders approvals settingsTabs interruptRenderers panels linkViews markdownFences markdownSyntax views brokerPublicPaths; }
