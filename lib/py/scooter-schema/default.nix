{ lib, python3Packages, ... }:

# scooter_schema — GENERATED SQLAlchemy models for the shared databases.
#
# The per-database model modules (webhooks/scheduler/broker/byoc) are generated
# from lib/sql/<db>/schema.sql by `just db-generate` (sqlacodegen). This package
# just ships them + the runtime ownership guard, so the Python services import one
# consistent set of models instead of hand-writing their own.

python3Packages.buildPythonPackage {
  pname = "scooter-schema";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    sqlalchemy
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
  ];
  # Importing each generated module proves the generation produced valid models
  # (SQLAlchemy resolves the columns/constraints) — a cheap guard against broken
  # or drifted output slipping through.
  pythonImportsCheck = [
    "scooter_schema.webhooks"
    "scooter_schema.scheduler"
    "scooter_schema.broker"
    "scooter_schema.byoc"
    "scooter_schema.guard"
  ];

  meta.description = "Generated SQLAlchemy models for Scooter's shared databases";
}
