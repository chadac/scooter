#!/usr/bin/env bash
# The conversation-token test vector is committed TWICE — once per service — because
# the agent-host and broker nix derivations each build from their own source tree and
# cannot share a path. Both suites verify the same token to catch wire-format drift
# between the TypeScript signer and the Python verifier (issue #700), which only works
# if the two copies are the same file.
#
# A drifted copy would make both suites pass while testing different formats — the
# exact failure the cross-language vector exists to prevent.
set -euo pipefail

cd "$(dirname "$0")/.."

A=services/agent-host/test/fixtures/conv-token.json
B=services/broker/tests/fixtures/conv-token.json

for f in "$A" "$B"; do
  if [ ! -f "$f" ]; then
    echo "❌ conv-token vector missing: $f" >&2
    exit 1
  fi
done

if ! diff -u "$A" "$B"; then
  cat >&2 <<EOF

❌ The two conversation-token test vectors have drifted.

   $A
   $B

They must be byte-identical: each test suite verifies the SAME token to prove the
TypeScript signer and the Python verifier agree on the wire format. Copy whichever
one you changed over the other:

   cp $A $B
EOF
  exit 1
fi

echo "✅ conv-token vector is identical across both services"
