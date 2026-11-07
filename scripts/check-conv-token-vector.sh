#!/usr/bin/env bash
# Cross-language token test vectors are committed once per service, because each nix
# derivation builds from its own source tree; both suites verify the same token to catch
# wire-format drift between signer and verifier, which only works if the copies match.
set -euo pipefail

cd "$(dirname "$0")/.."

# signer copy, verifier copy
pairs=(
  "services/agent-host/test/fixtures/conv-token.json services/broker/tests/fixtures/conv-token.json"
  "services/conversation-router/testdata/user-assertion.json services/broker/tests/fixtures/user-assertion.json"
)

for pair in "${pairs[@]}"; do
  read -r A B <<<"$pair"
  for f in "$A" "$B"; do
    if [ ! -f "$f" ]; then
      echo "❌ token vector missing: $f" >&2
      exit 1
    fi
  done
  if ! diff -u "$A" "$B"; then
    cat >&2 <<MSG

❌ Two copies of a token test vector have drifted.

   $A
   $B

They must be byte-identical: each suite verifies the SAME token to prove the signer
and the verifier agree on the wire format. Copy whichever one you changed over the
other:

   cp $A $B
MSG
    exit 1
  fi
done

echo "✅ token vectors are identical across services"
