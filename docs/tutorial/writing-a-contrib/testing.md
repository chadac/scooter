# Testing and shipping

## Unit tests

Put tests in `contrib/acme/tests/`. They run with pytest as part of the contrib's
**package build**, once for each service the contrib targets. So a broken test is a broken
build, and CI catches it without extra wiring.

Test the factories directly, driving them through the environment the way the deployment
does:

```python
# contrib/acme/tests/test_acme.py
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_contrib_acme.broker_provider import acme


def test_disabled_without_a_token(monkeypatch):
    monkeypatch.delenv("ACME_TOKEN", raising=False)
    assert acme().enabled is False


def test_proxies_to_the_acme_api(monkeypatch):
    monkeypatch.setenv("ACME_TOKEN", "acme-secret")
    provider = acme()
    assert provider.enabled
    proxy = next(t for t in provider.transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.acme.example"
```

For webhook handlers, mount the router in a FastAPI app and post signed and unsigned
deliveries with `TestClient`. For tools, see `contrib/echo/tests/test_mcp_tools.py`.

`tests/` is shared by both halves, so the whole directory runs in **each** variant's
build. Both services and every half's `pythonDeps` are available to the tests in every
variant, so a webhooks test runs fine in the broker build too. Just don't make a test
depend on which variant is running it.

Run them:

```bash
nix build .#contribs-all -L      # builds (and tests) every variant of every contrib
```

## Platform checks

The repo also checks the contrib from the platform's side. Run `just ci` before you open a
PR. It includes:

- **`just check-contrib-coverage`**: every contrib directory is imported by
  `contrib/all-modules.nix`, and has no stray `.nix` files.
- **`just check-manifests`**: renders `examples/kubenix-config.nix` and asserts on it.
  The example must configure **every shipped contrib's options**, so add yours:

    ```nix
    # examples/kubenix-config.nix
    contribs.acme = {
      enable = true;
      tokenSecret = { name = "acme-token"; key = "ACME_TOKEN"; };
      siteUrl = "https://acme.example/acme-corp";
    };
    ```

    The same check confirms that your skill ships when the contrib is enabled and not
    when it's disabled, and that configuring the contrib while it's disabled fails the
    render.

If the contrib has a sandbox half, the `dev-env-*` NixOS tests build the sandbox image with
it, and CI runs them on every PR.

## Shipping it

1. **Enable it in the published images.** Add `contribs.acme.enable = true;` to
   `.github/deployment/config.nix`, the contrib set CI builds and publishes.
2. **Open a PR.** CI builds the images. When it merges, `publish-images` pushes them, and
   their content-addressed tags are what `lib.evalPlatform` pins.
3. **Document it for operators.** Add a section to
   [Setting up contribs](../contribs.md), and to [Configuring webhooks](../webhooks.md)
   if it has a webhook half: which Secret to create, which options to set, and which
   events to subscribe to.

On a fork, the same steps publish to `ghcr.io/<you>/scooter/`. Deployments then set
`scooter.registryPrefix` to match (see [Extending Scooter](index.md#where-a-contrib-lives)).

Once the images are published, operators enable the contrib like any other:

```nix
contribs.acme = {
  enable = true;
  tokenSecret.name = "acme-token";
};
```
