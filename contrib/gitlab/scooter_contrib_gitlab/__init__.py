"""GitLab integration for Scooter, as a contrib module.

Everything GitLab-specific lives here: the broker provider (PAT proxy + git
credentials), the webhooks handler and its comment responses, the owner-email
lookup, and the URL shapes that say `https://gitlab.com/g/p/-/merge_requests/7`
and `g/p!7` are the same MR. Nothing imports the broker or webhooks app.
"""

CONTRIB_NAME = "gitlab"
