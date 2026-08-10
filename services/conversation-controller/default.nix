{ lib, python3Packages, ... }:

# The Conversation CRD controller (Python). Leader-elected reconcile loop that assigns
# each Conversation CR a hostPod (an agent-host replica) + reassigns on pod death. No
# request routing here (a later PR); this only records ownership. See
# todo/docs/CONVERSATION_CRD_PR1.md.

python3Packages.buildPythonApplication {
  pname = "conversation-controller";
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
  pythonImportsCheck = [ "conversation_controller.app" ];

  meta.description = "Scooter Conversation CRD controller (hostPod assignment)";
}
