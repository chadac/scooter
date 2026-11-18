# kubectl is in the base set, shared with docker.
{ pkgs }:
{ kubernetes-helm = { package = pkgs.kubernetes-helm; bins = [ "helm" ]; }; }
