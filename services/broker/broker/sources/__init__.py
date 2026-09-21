"""Provider-SPECIFIC credential sources.

Only `github_app` is left, and it belongs to exactly one integration — it travels
with the github provider into contrib/github, the way `datadog_keys` went with
contrib/datadog (#573) and `atlassian_oauth` with contrib/jira (#582). Keeping
them in the shared surface would leave provider-specific code in `shared`, which
is the opposite of what splitting into contribs is for (PR #567).
"""
