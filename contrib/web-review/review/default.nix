{ lib, buildGoModule, fetchurl, runCommand }:

# scooter-review (Go, stdlib only): the review-app proxy, the review shell and the
# agent's `review` CLI, one binary. `passthru.vendor` is the screenshot library the
# overlay loads on first capture, served by the proxy from the store.

let
  version = "4.7.0";
  tarball = fetchurl {
    url = "https://registry.npmjs.org/modern-screenshot/-/modern-screenshot-${version}.tgz";
    hash = "sha512-9YxN+ddPSMMlhylOv25VHzXrl9u67QRxoh7+SEewGtgUw7t6hHTrjptSDJUSne9oG4Xk/h2cwG15nIt4Hc9ujg==";
  };
  vendor = runCommand "scooter-review-vendor-${version}" { } ''
    mkdir -p $out
    tar xzf ${tarball} package/dist/index.js package/LICENSE
    cp package/dist/index.js $out/modern-screenshot.js
    cp package/LICENSE $out/modern-screenshot.LICENSE
  '';
in
buildGoModule {
  pname = "scooter-review";
  version = "0.0.0";
  src = lib.cleanSource ./.;
  vendorHash = null;
  env.CGO_ENABLED = "0";

  # The CLI is `review`; the services run `scooter-review proxy|shell`.
  postInstall = ''
    ln -s review $out/bin/scooter-review
  '';

  passthru = { inherit vendor; };
  meta.description = "Scooter web app review: proxy, shell and CLI";
}
