# config/custom scenario: OVERRIDE root's port (root default 8080 -> custom forces 8099).
{ lib, ... }: { services.markerService = { enable = lib.mkForce true; port = lib.mkForce 8099; }; }
