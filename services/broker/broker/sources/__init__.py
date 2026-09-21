"""Provider-SPECIFIC credential sources.

Each of these belongs to exactly one integration — `github_app` to github,
`atlassian_oauth` to jira, `datadog_keys` to datadog — so each travels WITH its
provider into that provider's contrib module in the integration slices. Putting
them in the shared surface would have kept github-specific code in `shared`,
which is the opposite of what splitting into contribs is for (PR #567).

The generic ones live in `scooter_broker_lib.sources`: `static_token`, which
five providers use, is a mechanism rather than an integration.

The test for "does this belong here or in the lib?" is whether a SECOND provider
could plausibly compose it. If only its own can, it is implementation and it
stays with its provider.
"""
