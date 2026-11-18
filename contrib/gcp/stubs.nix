{ pkgs }:
{ google-cloud-sdk = { package = pkgs.google-cloud-sdk; bins = [ "gcloud" "gsutil" "bq" ]; }; }
