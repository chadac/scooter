"""Broker-app transports — the ones that are NOT reusable extension surface.

Everything a provider composes lives in `scooter_broker_lib.transports`. What is
left here is `aws_permissions`, which reaches into `broker.aws.*` (the IAM
provisioner, the permission store, the approval flow) and so is the aws
provider's implementation rather than a mechanism another provider could use.

TODO(#567): revisit with the grant refactor — if that lands a reusable
grant/approval seam, the generic half of aws_permissions belongs in the lib and
only the AWS-specific half stays.
"""
