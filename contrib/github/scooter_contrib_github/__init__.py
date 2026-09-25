"""GitHub integration for Scooter, as a contrib module.

Everything GitHub-specific lives here: the broker provider with its App-token
credential source (which is also what vends `git clone` credentials for
github.com), the webhooks handler and its comment responses, the owner-email
lookup, and the URL shapes that say `https://github.com/o/r/pull/7` and `o/r#7`
are the same PR. Nothing imports the broker or webhooks app.
"""

CONTRIB_NAME = "github"
