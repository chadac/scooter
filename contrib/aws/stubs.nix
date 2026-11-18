{ pkgs }:
{ awscli2 = { package = pkgs.awscli2; bins = [ "aws" "aws_completer" ]; }; }
