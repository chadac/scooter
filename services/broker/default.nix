{ lib, python3Packages, ... }:

# The credential broker (Python/FastAPI). Design stage: build stub.
#
# python3Packages.buildPythonApplication {
#   pname = "agent-broker"; version = "0.0.0"; src = ./.;
#   pyproject = true;
#   dependencies = with python3Packages; [
#     fastapi uvicorn httpx pydantic pydantic-settings kubernetes pyjwt
#   ];
#   pythonImportsCheck = [ "broker.core.app" ];
# }

python3Packages.buildPythonApplication {
  pname = "agent-broker";
  version = "0.0.0";
  src = ./.;
  pyproject = true;
  doCheck = false; # placeholder until deps + impl exist
  nativeBuildInputs = [ python3Packages.setuptools ];
}
