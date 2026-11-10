{ lib, buildNpmPackage, nodejs, python3Packages, ... }:

# This conversation as a JupyterLab sidebar panel.
buildNpmPackage {
  pname = "scooter-jupyter-chat";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [ ./package.json ./package-lock.json ./src ./style ];
  };

  npmDepsHash = "sha256-EU/+45hj8yPRYckc6iMGoHhxsaZWYvVJVuLy8S+fGJw=";

  buildPhase = ''
    runHook preBuild
    ${nodejs}/bin/node node_modules/@jupyterlab/builder/lib/build-labextension.js \
      --core-path ${python3Packages.jupyterlab}/${python3Packages.python.sitePackages}/jupyterlab/staging .
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/jupyter/labextensions
    cp -r labext $out/share/jupyter/labextensions/scooter-jupyter-chat
    runHook postInstall
  '';
}
