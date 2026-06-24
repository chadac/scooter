"""aws-permissions transport — dynamic, approval-gated AWS access.

DESIGN BOILERPLATE (route signatures only). Mounts under /{provider}/aws/*. Every
route authenticates via the SA token (Depends(authed) -> Identity); the
conversation_id comes from the identity, NEVER the body — so cross-conversation
isolation + caller identity are free (unlike the reference's API-key + session
token).

Routes (agent-facing unless noted):
  GET    /aws/accounts                 discovery: enabled accounts + their bounds
  POST   /aws/request                  request a scoped permission  -> {request_id, status}
  POST   /aws/escalate                 request more (parent_request_id) -> {request_id, status}
  GET    /aws/{request_id}             status + creds (when active) [isolated]
  POST   /aws/{request_id}/refresh     fresh STS creds within the role TTL
  DELETE /aws/{request_id}             self-revoke
  GET    /aws/audit                    audit query (admin)
  POST   /aws/{request_id}/approve     APPROVER: pending -> active (provision)   [admin]
  POST   /aws/{request_id}/deny        APPROVER: pending -> denied               [admin]

Approval default is in-conversation (the agent-host turns a pending request into
an AG-UI interrupt and calls approve/deny on the user's pick). is_admin is a
deployer-configured seam. Slack approval is a TODO (docs/AWS_PERMISSIONS_BROKER.md).
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter

from ..core.types import AuthDependency, Provider, Transport


@dataclass
class AwsPermissions(Transport):
    name: str = "aws-permissions"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        """Mount the agent + approver routes. The PermissionService (held by the
        provider's source/config) does the work; these are thin adapters that
        pull conversation_id from the authed Identity and map errors to HTTP."""
        ...
