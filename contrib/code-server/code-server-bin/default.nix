# code-server from coder's prebuilt release tarball, patched for NixOS. Replaces nixpkgs'
# source build: the agent-host bridge (--agent-host-bridge-port) needs VS Code >= 1.141,
# ahead of nixpkgs, and a prebuilt tarball materialises in seconds on first use.
{ lib, stdenv, fetchurl, autoPatchelfHook, makeWrapper, krb5, libsecret, nodejs_24, ... }:

let
  version = "4.141.0"; # bundles VS Code 1.141.0
  # Matches the release's bundled node; installPhase checks the addon ABI.
  nodejs = nodejs_24;
  srcs = {
    x86_64-linux = fetchurl {
      url = "https://github.com/coder/code-server/releases/download/v${version}/code-server-${version}-linux-amd64.tar.gz";
      hash = "sha256-ZbzSC1JNA+sbWtt/NgJEWZ7w5bdAiaRqmC0ywHS5eik=";
    };
    aarch64-linux = fetchurl {
      url = "https://github.com/coder/code-server/releases/download/v${version}/code-server-${version}-linux-arm64.tar.gz";
      hash = "sha256-5cx42h1jHGz2Fi+bGO6qjunTI54aiLuZ0GAs3F+hhS0=";
    };
    x86_64-darwin = fetchurl {
      url = "https://github.com/coder/code-server/releases/download/v${version}/code-server-${version}-macos-amd64.tar.gz";
      hash = "sha256-sTPgAsKhpPIrLsQsXyMxR/NCtZLi6tysxRcDqG9Ef3c=";
    };
    aarch64-darwin = fetchurl {
      url = "https://github.com/coder/code-server/releases/download/v${version}/code-server-${version}-macos-arm64.tar.gz";
      hash = "sha256-q0Wtlgclvc37kpmO9U/rL0eQeSJDFc5EpPScVAk0U8k=";
    };
  };
in
stdenv.mkDerivation {
  pname = "code-server";
  inherit version;
  src = srcs.${stdenv.hostPlatform.system} or (throw "code-server-bin: unsupported system ${stdenv.hostPlatform.system}");

  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ] ++ [ makeWrapper ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib krb5 libsecret ];
  # The microsoft-authentication extension's native broker is a desktop GUI component that a
  # headless server never loads; without it the extension falls back to browser sign-in.
  autoPatchelfIgnoreMissingDeps = [
    "libX11.so.6" "libdbus-1.so.3" "libcurl.so.4" "libcrypto.so.3"
    "libwebkit2gtk-4.1.so.0" "libgtk-3.so.0" "libgdk-3.so.0" "libsoup-3.0.so.0"
  ];

  dontConfigure = true;
  dontBuild = true;
  dontStrip = true; # node and its native addons ship stripped; restripping only risks them

  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec/code-server $out/bin
    cp -r . $out/libexec/code-server
  '' + lib.optionalString stdenv.hostPlatform.isLinux ''
    # autoPatchelf corrupts the bundled node, so use nixpkgs' node.
    abi() { "$@" -p process.versions.modules; }
    bundled=$(abi "$(< $NIX_CC/nix-support/dynamic-linker)" --library-path ${lib.getLib stdenv.cc.cc}/lib ./lib/node)
    ours=$(abi ${lib.getExe nodejs})
    if [ "$bundled" != "$ours" ]; then
      echo "bundled node has addon ABI $bundled but ${nodejs.name} has $ours; bump nodejs" >&2
      exit 1
    fi
    ln -sf ${lib.getExe nodejs} $out/libexec/code-server/lib/node
  '' + ''
    # The release launcher only resolves its own root, using coreutils; call lib/node directly.
    makeWrapper $out/libexec/code-server/lib/node $out/bin/code-server \
      --add-flags $out/libexec/code-server
    runHook postInstall
  '';

  # Fails the build, not the sandbox, if node is broken.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    HOME=$TMPDIR $out/bin/code-server --version
    runHook postInstallCheck
  '';

  meta = {
    description = "VS Code in the browser (prebuilt release)";
    homepage = "https://github.com/coder/code-server";
    license = lib.licenses.mit;
    platforms = builtins.attrNames srcs;
    mainProgram = "code-server";
  };
}
