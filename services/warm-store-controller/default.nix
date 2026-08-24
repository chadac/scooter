{ lib, python3Packages, ... }:

# The warm /nix/store PVC pool controller (Python). Leader-elected reconcile loop that
# keeps a pool of overlay-upper PVCs warmed against the current sandbox image tag: tops up
# (warm Jobs), GCs retired tags, returns claimed PVCs on suspend, and recovers leaks. Runs
# alongside the upstream agent-sandbox controller (which owns the Sandbox→pod/PVC lifecycle).
# The agent-host provisioner does the CLAIM (claimName swap). See

python3Packages.buildPythonApplication {
  pname = "warm-store-controller";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    kubernetes
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
  ];
  pythonImportsCheck = [ "warm_store_controller.app" ];

  meta.description = "Scooter warm /nix/store PVC pool controller";
}
