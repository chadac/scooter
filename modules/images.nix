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

      source = mkOption {
        type = types.enum [ "registry" "imageless" ];
        default = cfg.imageSource;
        defaultText = literalExpression "config.scooter.imageSource";
        description = "Pull the image from its registry, or have the node realize an imageless release.";
      };

      imageless = {
        runtimeClass = mkOption {
          type = types.str;
          default = cfg.imageless.runtimeClass;
          defaultText = literalExpression "config.scooter.imageless.runtimeClass";
          description = "RuntimeClass whose handler is imageless-runc.";
        };

        writableDirs = mkOption {
          type = types.listOf types.str;
          default = config.package.imagelessSource.writableDirs or [ "/tmp" "/var/run/secrets" ];
          defaultText = literalExpression ''[ "/tmp" "/var/run/secrets" ]'';
          description = ''
            Dirs given an emptyDir, since an imageless root is read-only. A volume may
            mount anywhere under one without a mountpoint in the rootfs.
          '';
        };

        mountPoints = mkOption {
          type = types.listOf types.str;
          default = config.package.imagelessSource.mountPoints or [ ];
          defaultText = literalExpression "[ ]";
          description = "Dirs a volume mounts onto outside `writableDirs`; the render fails on a missing one.";
        };

        built = mkOption {
          type = types.nullOr (types.attrsOf types.raw);
          readOnly = true;
          internal = true;
          default =
            if config.package == null || !(config.package ? imagelessSource) then null
            else import ../pkgs/imageless/rootfs.nix { pkgs = cfg.config.buildPkgs; inherit lib; } {
              inherit (config.package.imagelessSource) name copyToRoot config;
              inherit (config.imageless) writableDirs mountPoints;
            };
          description = "The rootfs and process, from the package's copyToRoot and config.";
        };

        release = mkOption {
          type = types.nullOr types.package;
          readOnly = true;
          default =
            if config.imageless.built == null then null
            else cfg.config.buildPkgs.callPackage "${cfg.config.inputs.imageless}/nix/release-catalog.nix" {
              rootfsTargets.${cfg.config.buildSystem} = config.imageless.built.rootfs;
              inherit (cfg.imageless) issuer cache;
              releaseName = name;
              inherit (config.imageless.built) process;
            };
          defaultText = literalExpression "the image's release catalog";
          description = "This image's release catalog: `sha256/<digest>.json`, plus `.reference`.";
        };

        reference = mkOption {
          type = types.nullOr types.str;
          default = if config.imageless.release == null then null else config.imageless.release.reference;
          defaultText = literalExpression "imageless.release.reference";
          description = "The `imageless.run/release-v1` value. Override to pin a published release.";
        };

        image = mkOption {
          type = types.nullOr types.str;
          readOnly = true;
          # Same repo, own tag: an image-keyed rollout or warm store still sees a change.
          default =
            if config.imageless.reference == null then null
            else "${config.ref.image}:imageless-${builtins.substring 0 12 (lib.last (lib.splitString ":" config.imageless.reference))}";
          defaultText = literalExpression ''"''${ref.image}:imageless-<digest prefix>"'';
          description = "Where CI pushes `placeholder`, and what an imageless pod names.";
        };

        placeholder = mkOption {
          type = types.nullOr types.package;
          readOnly = true;
          default =
            if config.imageless.built == null then null
            else cfg.config.n2c.buildImage {
              name = "${name}-imageless";
              # The OCI config the kubelet reads (stop signal, user), over a near-empty layer.
              inherit (config.package.imagelessSource) config;
              copyToRoot = cfg.config.buildPkgs.writeTextDir "etc/imageless-placeholder" ''
                This image's root is realized by the node from ${config.imageless.reference}.
              '';
            };
          defaultText = literalExpression "an image with this one's config and no content";
          description = "What `pod.image` names; CI pushes it to the image's repo under that tag.";
        };
      };

      pod = mkOption {
        type = types.attrsOf types.raw;
        readOnly = true;
        description = "What a pod running this image needs: `image`, plus `runtimeClassName` and `annotations` when imageless.";
        default =
          if config.source == "registry" then { image = config.ref.fullUrl; }
          else if config.imageless.reference == null then
            throw "scooter.images.${name}: source = \"imageless\" needs a package built with nix2container, or imageless.reference."
          else {
            inherit (config.imageless) image;
            runtimeClassName = config.imageless.runtimeClass;
            annotations."imageless.run/release-v1" = config.imageless.reference;
          };
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

  options.scooter.imageSource = mkOption {
    type = types.enum [ "registry" "imageless" ];
    default = "registry";
    description = ''
      Where each image comes from by default. `imageless` runs a placeholder image
      whose root the node realizes from an imageless release (github.com/dmadisetti/imageless),
      fetched from a binary cache; nodes need the imageless runtime installed.
    '';
  };

  options.scooter.imageless = {
    runtimeClass = mkOption {
      type = types.str;
      default = "imageless";
      description = "RuntimeClass whose containerd handler is imageless-runc.";
    };
    issuer = mkOption {
      type = types.str;
      default = "scooter";
      description = "Release issuer; nodes map it to a catalog URL in their policy.";
    };
    cache = mkOption {
      type = types.str;
      default = "default";
      description = "Cache identity each release names; nodes map it to a substituter.";
    };
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
