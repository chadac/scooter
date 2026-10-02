{ lib, stdenvNoCC, fetchurl }:

# Keep the Atlas command/config surface; Ptah Compat also diffs PostgreSQL
# functions and triggers. Pin the release bytes for every supported platform.
let
  version = "0.11.4";
  release = {
    x86_64-linux = { archive = "linux_amd64"; hash = "sha256-3g8tSVcO1XVFtQttTeg+WJGEenmSHQ7O8mJGe9s4pTs="; };
    aarch64-linux = { archive = "linux_arm64"; hash = "sha256-WN1+jDKL+CU9fPhg832o9GGcWeXg2Be8YwlHB8xusUw="; };
    x86_64-darwin = { archive = "darwin_amd64"; hash = "sha256-0naDD2NlcW4sc4EpZcMm0vn5ciOcfyCAkgQ6l3zzyHY="; };
    aarch64-darwin = { archive = "darwin_arm64"; hash = "sha256-HXK4+AHVcPXQp053XEP3pjAWo3Wcw0cYBXyq+UovsjA="; };
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
