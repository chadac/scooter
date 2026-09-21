{ lib, python3Packages, ... }:

# scooter_lib — shared, service-agnostic library for the Python services
# (logging convention, common config/auth primitives). Both extension-surface
# libs (scooter_broker_lib / scooter_webhooks_lib) and the contribs build on it.

python3Packages.buildPythonPackage {
  pname = "scooter-lib";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.hatchling ];

  dependencies = with python3Packages; [
    pydantic
    pydantic-settings
  ];

  # No pytestCheckHook yet — this is a skeleton (0 tests would fail collection).
  # Re-added with the modules + their tests in the follow-up commits.
  pythonImportsCheck = [ "scooter_lib" ];

  meta.description = "Shared library for Scooter's Python services";
}
