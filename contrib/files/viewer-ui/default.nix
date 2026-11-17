# The files viewer's frontend: React + @pierre/diffs (code), react-markdown
# (documents) and Shiki, built by Vite into one static tree that server.py serves
# as SCOOTER_FILES_STATIC. Everything is bundled, so the page needs no CDN and
# renders in a deployment with no egress; each Shiki grammar is its own chunk and
# loads only when a file in that language is opened.

{ lib, buildNpmPackage }:

buildNpmPackage {
  pname = "scooter-files-viewer-ui";
  version = "0.0.0";

  # Only what the build reads, so a local node_modules/ or dist/ never leaks in.
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./index.html
      ./tsconfig.json
      ./vite.config.ts
      ./src
    ];
  };

  npmDepsHash = "sha256-APyupG/g5QsrIMKRu/QssYLdrv/3BEGXqHOBvxxmAAQ=";

  # Static output, no bin to wrap.
  installPhase = ''
    runHook preInstall
    cp -r dist $out
    runHook postInstall
  '';

  meta.description = "Frontend for the scooter files viewer (static site)";
}
