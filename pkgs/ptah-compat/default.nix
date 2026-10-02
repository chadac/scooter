{ lib, stdenvNoCC, fetchurl }:

# Keep the Atlas command/config surface; Ptah Compat also diffs PostgreSQL
# functions and triggers. Pin the release bytes for every supported platform.
let
  version = "0.12.0";
  release = {
    x86_64-linux = { archive = "linux_amd64"; hash = "sha256-sQnmHUHy+QdRE/dY/DhtzlsON9GiCuwfIhLgtfVcd90="; };
    aarch64-linux = { archive = "linux_arm64"; hash = "sha256-2Mb7uxQ2bSeA+INq3RczhW+GaDa9VOs9ne5MS9zuf9o="; };
    x86_64-darwin = { archive = "darwin_amd64"; hash = "sha256-TAwnQLyFSG9Ncg4Rr6UCwDzgofTHs8HpKJso41uDmPA="; };
    aarch64-darwin = { archive = "darwin_arm64"; hash = "sha256-HC5tX+PZ0D3Xjhnz9Cw4b9n/CUlSLo3015vlyTN7/iY="; };
  }.${stdenvNoCC.hostPlatform.system};
in
stdenvNoCC.mkDerivation {
  pname = "ptah-compat";
  inherit version;
  src = fetchurl {
    url = "https://github.com/stokaro/ptah/releases/download/v${version}/ptah_${version}_${release.archive}.tar.gz";
    inherit (release) hash;
  };
  sourceRoot = ".";
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 ptah-compat "$out/bin/ptah-compat"
    ln -s ptah-compat "$out/bin/atlas"
    install -Dm644 LICENSE "$out/share/licenses/ptah/LICENSE"
    runHook postInstall
  '';
  meta = {
    description = "Ptah's Atlas-compatible database migration CLI";
    homepage = "https://ptah.run/";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    mainProgram = "atlas";
  };
}
