"""Render a per-conversation Sandbox manifest to stdout as JSON.

EXISTS FOR THE CLUSTER TESTS. test/cluster/*.spec.ts needs a real sandbox to exec
into, and the manifest is not something a test can hand-roll: a Sandbox without the
cgroup-delegating runtimeClass, CAP_SYS_ADMIN, the tmpfs /run + /tmp and the overlay
PVC does not boot the NixOS systemd image at all. Re-implementing it in the test
harness would recreate the very TS/Python fork this replaced (see PR #574), so the
tests call THIS — the same sandbox_manifest() the broker provisions with.

    scooter-sandbox-manifest --conv abc123 --image agent-sandbox-os:latest \
        --namespace agent-sandbox-test [--runtime-class crun] [--pull-policy Never]

Deliberately NOT a general admin tool: it only renders, never writes to a cluster.
"""

from __future__ import annotations

import argparse
import json
import sys

from .manifest import DeployConfig, sandbox_manifest


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="scooter-sandbox-manifest", description=__doc__)
    p.add_argument("--conv", required=True, help="conversation id (the SHORT, DNS-safe one)")
    p.add_argument("--image", required=True, help="sandbox image ref")
    p.add_argument("--namespace", default="agent-sandbox")
    p.add_argument("--runtime-class", default=None, help='e.g. "crun"; omit for the cluster default')
    p.add_argument("--pull-policy", default="Always", choices=["Always", "IfNotPresent", "Never"])
    p.add_argument("--thread-id", default=None, help="full thread id for CONVERSATION_URL")
    p.add_argument("--resources-json", default=None, help="rendered k8s resources block")
    args = p.parse_args(argv)

    manifest = sandbox_manifest(
        conversation_id=args.conv,
        name=f"conv-{args.conv}",
        service_account=f"sandbox-{args.conv}",
        deploy=DeployConfig(
            namespace=args.namespace,
            sandbox_image=args.image,
            pull_policy=args.pull_policy,
            runtime_class=args.runtime_class,
        ),
        resources=json.loads(args.resources_json) if args.resources_json else None,
        url_thread=args.thread_id,
    )
    json.dump(manifest, sys.stdout)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
