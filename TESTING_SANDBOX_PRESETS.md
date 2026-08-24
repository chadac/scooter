# Testing Plan: Named Sandbox Size Presets

## Unit Tests

### 1. Preset name → resolved resources (test_sandbox_routes.py)
- ✅ `test_put_size_accepts_preset_name`: PUT /sandbox/{conv}/size with `{"size": "large"}` stores the resolved resources (4 CPU / 16Gi, requests == limits)
- ✅ `test_put_size_rejects_unknown_preset`: PUT with `{"size": "xlarge"}` returns 400 with error message listing available presets

### 2. Default preset must exist in map (kubenix assertion)
- ✅ Added assertion in `modules/platform.nix` that fails at eval-time if `cfg.defaultSandboxSize` is not a key in `cfg.sandboxSizes`
- Test: Set `defaultSandboxSize = "xlarge"` without defining it → eval fails with clear message

### 3. Sizing up requires approval; down doesn't (Q2)
- Location: `services/broker/broker/aws/` approval logic
- **TODO**: Add test comparing size change direction to approval requirement
- Note: This is AWS permissions broker logic, separate from the size spec itself

### 4. Resume does NOT re-approve (Q2b)
- **Critical test**: Set a size with approval, suspend, resume → assert same size applied and NO approval requested
- Location: Integration test in `nixos-tests/` or manual verification
- Mutation: Remove the size persistence → resume fails or re-requests approval

### 5. Subagent refused (Q4)
- **TODO**: Add test that a conversation with `parentId` gets 403 when calling PUT /sandbox/{conv}/size
- Location: `test_sandbox_routes.py`, add identity with `parent_id` set

### 6. Absent size → deployment default (Q5)
- ✅ Existing test `test_get_size_returns_none_when_unset` verifies unset size returns None
- ✅ `test_ensure_applies_the_stored_size` verifies stored size is applied
- Integration test needed: Create conversation without size → verify it gets deployment default (medium: 2/4Gi)

### 7. Tier 2 (cluster): tiny preset gets 250m/256Mi on Sandbox spec
- **Integration test**: Create conversation with size="tiny", inspect the Sandbox CR `.spec.podTemplate.spec.containers[0].resources`
- Location: `nixos-tests/` cluster tests (path-gated in CI)
- Verifies the full chain: UI/agent → agent-host → broker → k8s Sandbox manifest

### 8. TS and Python quantity regexes agree
- Location: `resources.py:9-10` documents they must be identical
- **TODO**: Add test that compiles both regexes and tests the same set of valid/invalid quantities against both
- File: New test in `services/agent-host/tests/` and `services/broker/tests/`

## Mutation Check

**Goal**: Verify tests 1 and 7 fail when the preset resolution is broken.

### Mutation 1: Map every preset name to the default
Change `sandbox/routes.py` line ~120:
```python
# BEFORE (correct):
spec = preset_to_resources(sizes[preset_name])

# AFTER (mutated — always use "medium"):
spec = preset_to_resources(sizes["medium"])
```

**Expected failures**:
- `test_put_size_accepts_preset_name`: Asserts large → 4/16Gi, but gets 2/4Gi
- Tier 2 test: Asserts tiny → 250m/256Mi, but gets 2/4Gi

### Mutation 2: Don't render presets into SANDBOX_DEFAULT_RESOURCES_JSON
Remove the env var in `modules/broker.nix` (or set it to empty string).

**Expected failures**:
- Integration test: Deployment default should be medium (2/4Gi), but falls back to PLATFORM_DEFAULT

## Test Execution

### Local (unit tests):
```bash
cd services/broker
pytest tests/test_sandbox_routes.py tests/test_sandbox_presets.py -v
```

### Cluster (integration — path-gated):
```bash
nix build .#checks.x86_64-linux.sandbox-lifecycle-broker
# Verifies:
# - Sandbox CR is created with correct resources from preset
# - Size changes apply on resume
# - GET /sandbox-sizes returns the rendered preset map
```

## Verification Checklist

- [ ] All unit tests pass
- [ ] Mutation check: test_put_size_accepts_preset_name fails with mutation 1
- [ ] Mutation check: Tier 2 test fails with mutation 1
- [ ] Kubenix eval fails when defaultSandboxSize is not in sandboxSizes
- [ ] Skill documentation updated to reflect presets (not just raw quantities)
- [ ] All four hardcoded 2/4Gi references updated to reference presets
- [ ] PR includes exact test-command output with counts
- [ ] PR includes mutation-check results (which tests failed for each mutation)
