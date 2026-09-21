{ lib, python3Packages, scooterLib, ... }:

# scooter_broker_lib — the broker extension surface (provider/transport/source
# contracts + reusable building blocks). A broker provider — in-tree or a contrib
# — build-depends on this instead of the broker app, which breaks the app<->contrib
# build cycle. Depends only on scooter_lib.

python3Packages.buildPythonPackage {
  pname = "scooter-broker-lib";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.hatchling ];

  dependencies = with python3Packages; [
    scooterLib
    fastapi
    httpx
    pyjwt
  ];

  # No pytestCheckHook yet — skeleton (0 tests would fail collection).
  # Re-added with the modules + their tests in the follow-up commits.
  pythonImportsCheck = [ "scooter_broker_lib" ];

  meta.description = "The broker extension surface for Scooter providers";
}
