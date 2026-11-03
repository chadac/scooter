# What imagegen is; backends are declared under its own `backends.<name>`, and its
# deployment half (IRSA for Bedrock) is ./deployment.nix.
{ lib, ... }:

let
  inherit (lib) mkOption types;

  # A backend's own schema: the three fields every selector/cap needs, plus whatever
  # else that backend's factory reads off the config (apiKeySecret, url, …) —
  # those live in each backend's own code or typed module, never in this shared schema.
  backendOptions = {
    freeformType = with types; attrsOf anything;
    options = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = "Make this backend a candidate for generate_image.";
      };
      priority = mkOption {
        type = types.int;
        default = 100;
        description = "Higher tries first in the built-in \"priority\" selector; unused by a custom one.";
      };
      dailyLimit = mkOption {
        type = types.nullOr types.int;
        default = null;
        description = ''
          Per-user daily cap on THIS backend. Stacks with the contrib-wide `dailyLimit`:
          a user over either is skipped for this backend. null = no backend-specific cap.
        '';
      };
    };
  };
  backendModule = types.submodule backendOptions;

  # The shipped Bedrock backend's own fields, typed so the defaults reach its factory.
  bedrockModule = {
    options = {
      region = mkOption {
        type = types.str;
        default = "us-west-2";
        description = "AWS region for bedrock-runtime; Stable Image Core is in-region only in us-west-2.";
      };
      models = mkOption {
        type = types.nonEmptyListOf types.str;
        default = [ "stability.stable-image-core-v1:1" ];
        example = [ "stability.stable-image-core-v1:1" "amazon.nova-canvas-v1:0" ];
        description = ''
          Bedrock model ids to offer, the first being the default. Each must start with a
          prefix the backend knows the request shape of: `stability.` (Stable Image
          Core/Ultra, SD3.5), `amazon.titan-image-generator` or `amazon.nova-canvas`.
          The broker's role needs `bedrock:InvokeModel` on each, with model access granted.
        '';
      };
    };
  };
in
{
  # The strict module form (rather than a plain attrset) so `config` below is THIS
  # submodule's own resolved tree — `dailyLimit`/`selector`/`backends` — needed to
  # render them into broker env.
  contribs.imagegen = { config, lib, ... }: {
    options = {
      dailyLimit = mkOption {
        type = types.int;
        default = 50;
        description = "Per-user daily cap on generated images, counted across every backend.";
      };
      selector = mkOption {
        type = types.str;
        default = "priority";
        description = ''
          Entry point in the `scooter_imagegen.selectors` group that orders candidate
          backends when the agent does not name one: `select(request, candidates, usage)
          -> ordered candidates`. The broker tries them in that order, falling through on
          an error or an exhausted limit. The built-in "priority" drops backends over
          their limit and sorts the rest by `priority`, highest first.
        '';
      };
      backends = mkOption {
        type = types.submodule {
          freeformType = types.attrsOf backendModule;
          options.bedrock = mkOption {
            type = types.submoduleWith { modules = [ backendOptions bedrockModule ]; };
            default = { };
            description = "The shipped Bedrock backend: `backendModule`'s fields plus region and models.";
          };
        };
        default = { };
        example = lib.literalExpression ''
          { bedrock = { enable = true; priority = 100; }; }
        '';
        description = ''
          Backends, keyed by their name in the `scooter_imagegen.backends` entry-point
          group. A backend ships its Python unconditionally (it is part of this contrib
          or an out-of-tree package already a pythonDep); this is what turns it ON for
          generate_image and sets its cap and tie-breaking priority.
        '';
      };
    };

    config = {
      src = ./.;

      # Its own database (contrib_imagegen): one row per generation, which `usage.py`
      # counts against today for the per-user / per-backend caps.
      db = {
        enable = true;
        tables.generations = { };
      };

      services.broker = {
        enable = true;
        # boto3 for the shipped Bedrock backend; jsonschema to validate a model's params
        # against the manifest it publishes. An out-of-tree backend brings its own deps.
        pythonDeps = ps: [ ps.boto3 ps.jsonschema ];
        env = {
          IMAGEGEN_DAILY_LIMIT = toString config.dailyLimit;
          IMAGEGEN_SELECTOR = config.selector;
          # Not secret (a backend's own secrets are its own env, via mkSecretOption):
          # enable/priority/dailyLimit plus whatever extra fields that backend reads.
          IMAGEGEN_BACKENDS_JSON = builtins.toJSON config.backends;
        };
      };

      skills."scooter-imagegen.md" = ./skills/scooter-imagegen.md;
    };
  };
}
