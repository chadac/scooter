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

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    httpx # format_error is specified against real httpx exception types
  ];
  pythonImportsCheck = [ "scooter_lib.logging_config" ];

  meta.description = "Shared library for Scooter's Python services";
}
