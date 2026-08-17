# config/custom scenario: turn the marker service ON (extends root, which ships it OFF).
{ lib, ... }: { services.markerService.enable = lib.mkForce true; }
