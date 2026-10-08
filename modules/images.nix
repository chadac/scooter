# scooter.images.<name>: one ref per image, for every render.
{ config, lib, ... }:

let
  inherit (lib) mkOption types literalExpression;
  cfg = config.scooter;

  imageModule = { name, config, ... }: {
    options = {
      package = mkOption {
        type = types.nullOr types.package;
        default = null;
        description = "The image derivation. Null when a deployer only has a ref.";
      };

      ref = mkOption {
        description = "Where this image lives. Override image/tag to ship from elsewhere.";
        type = types.submodule {
          options = {
            image = mkOption {
              type = types.str;
              default = "${cfg.registryPrefix}${name}";
              defaultText = literalExpression ''"''${registryPrefix}<name>"'';
              description = "Registry path, no tag.";
            };
            tag = mkOption {
              type = types.str;
              default = if config.package == null then "latest" else cfg.imagesContentTag config.package;
              defaultText = literalExpression "the package's 12-char store hash, else \"latest\"";
              description = "Tag only. Content-addressed, so an unchanged image does not roll pods.";
            };
            fullUrl = mkOption {
              type = types.str;
              default = "${config.ref.image}:${config.ref.tag}";
              defaultText = literalExpression ''"''${ref.image}:''${ref.tag}"'';
              description = "What a manifest names.";
            };
          };
        };
        default = { };
      };

      attr = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "The flake packages attr that builds this, for CI to push.";
      };

      refKey = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Its camelCase key in ghcr-image-refs; null to omit it.";
      };

      path = mkOption {
        type = types.nullOr types.str;
        default = if config.package == null then null else "${config.package}";
        defaultText = literalExpression "the package's store path";
        description = "Store path, for a side-load render that bypasses a registry.";
      };
    };
  };
in
{
  options.scooter.images = mkOption {
    default = { };
    # submoduleWith, so an image can add its own options via imports.
    type = types.attrsOf (types.submoduleWith { modules = [ imageModule ]; });
    description = ''
      Images by canonical name (agent-host, agent-sandbox-os, ...). Each carries
      a `ref` for manifests, a `package` for builds and a `path` for side-loads.
    '';
  };

  options.scooter.imagesContentTag = mkOption {
    internal = true;
    type = types.functionTo types.str;
    description = "package -> tag. Discards string context so a ref costs no build.";
  };

  config.scooter.imagesContentTag = img:
    # unsafeDiscardStringContext: without it a ref carries the image as a build
    # dep, so reading a tag would realise every image.
    builtins.unsafeDiscardStringContext
      (builtins.substring 0 12 (builtins.baseNameOf img.outPath));
}
