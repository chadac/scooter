# Webhook Routing Design Decisions

## Overview
This document captures the design decisions for routing PR/MR/issue activity (CI failures, comments) back to the conversation that owns the linked resource.

## Answers to Open Questions

### Q1: Do SUCCESSFUL checks notify?
**Decision: Notify on success ONLY if the conversation is already awake; always notify on failure.**

**Rationale:**
- Failures are actionable and urgent — the agent needs to know immediately to fix the issue.
- Success is confirmatory, not actionable — waking a suspended sandbox just to say "all green" wastes resources.
- If the conversation is already awake (actively working), success is useful feedback.
- This balances utility (agent sees completion) with cost (no unnecessary wake-ups).

**Implementation:**
- Check `conversationStatus === "running"` before notifying on success.
- Always notify on failure/cancelled/timed_out regardless of status.

### Q2: Two conversations linked to one PR — notify both, the most recent, or refuse?
**Decision: Notify ALL linked conversations.**

**Rationale:**
- Multiple conversations on the same PR is a real scenario (e.g., two agents working different angles, or a human supervision conversation + an agent conversation).
- Notifying all ensures no conversation misses important updates.
- A stale link is a data-quality problem to fix separately (add a "dismiss link" feature later).
- The alternative (notify only the most recent) is fragile — "most recent" by what metric? createdAt? lastActivityAt? Either can be wrong.

**Implementation:**
- Use `findAllConversationsByLink()` instead of `findConversationByLink()`.
- Iterate and notify each conversation in the result set.

### Q3: Does a notification RESUME a suspended sandbox?
**Decision: Resume on failure; queue (don't resume) on success.**

**Rationale:**
- Failure notifications are urgent and actionable — the agent should wake up to fix the issue.
- Success notifications are confirmatory — if the conversation is suspended, it's done and doesn't need to wake.
- This minimizes resource usage while ensuring critical events get immediate attention.

**Implementation:**
- On failure/cancelled: call `sessions.revive(convId)` if status is "suspended", then inject the message.
- On success: if suspended, queue the message for the next manual resume (or skip it).

### Q4: Provide an off switch per conversation?
**Decision: Yes — add a conversation-level notification preference (future enhancement).**

**Rationale:**
- A human supervising a batch of agents may want to stop auto-reaction for specific conversations.
- The off switch should be per-conversation, not global (different conversations have different needs).
- This is a **future enhancement** — not blocking for the initial implementation.

**Implementation (future):**
- Add a `notificationsEnabled: boolean` field to ConversationMeta (default true).
- Check it before routing notifications.
- Expose a UI toggle and/or an agent tool to set it.

### Q5: Rate limiting
**Decision: Cap at 1 notification per (conversation, PR, event type) per 5-minute window.**

**Rationale:**
- A flapping test could trigger dozens of check_suite events in a short window — notifying for each is spam.
- Collapse repeats into one message: "CI failed 3 times in the last 5 minutes."
- Track per (conversation, PR URL, event type) so different events (e.g., a comment + a check failure) are not collapsed.

**Implementation:**
- Maintain an in-memory rate-limit cache: `Map<string, number>` where key is `${convId}|${prUrl}|${eventType}` and value is the last-notified timestamp.
- Before notifying, check if `now - lastNotified < 300_000` (5 minutes). If true, skip or batch.
- For batching: accumulate a count and send one message summarizing the batch.

## Loop Prevention (Load-Bearing)

**The agent pushes → CI runs → the agent is notified → it pushes again.**
Without a guard, this is an **infinite loop** burning tokens and CI minutes.

### Guards:
1. **Ignore events authored by the agent's own GitHub App.**
   - Check `event.sender.login` or `event.actor` against known app identities: `["app/scooter", "scooter[bot]"]`.
   - Case-insensitive substring match (e.g., `actor.toLowerCase().includes("scooter")` when the app is "scooter").

2. **Rate limit per (conversation, PR)** (see Q5).

### Test Coverage (Load-Bearing):
- Test #3 in `webhookRouting.spec.ts`: **mutation-check** — remove the self-authored guard, confirm the test fails.

## Notification Format

A `source: "webhook"` system message so the UI renders it distinctly. Include enough to act on WITHOUT a round trip:

```
[System: CI on PR #324 failed — check "fast checks (flake + typecheck + Tier 1 + python)".
 Run `gh run view <run_id> --log-failed` for details. Fix, push, and confirm the checks pass.]
```

### Fields to include:
- **Check name** (e.g., "fast checks (flake + typecheck + Tier 1 + python)")
- **Run ID** (so the agent can fetch logs directly)
- **Conclusion** (failure / success / cancelled)
- **PR number** (for context)

A bare "CI failed" forces the agent to go looking — don't ship that.

## Events That Notify

| Event | Notify? | Rationale |
|-------|---------|-----------|
| `check_suite.completed` (conclusion != success) | **YES** | Highest value — actionable failures |
| `check_run.completed` (conclusion != success) | **YES** | Same as check_suite |
| `issue_comment.created` (human author) | **YES** | Human feedback is always relevant |
| `pull_request_review.submitted` (changes_requested / commented) | **YES** | Review feedback is actionable |
| `status` (legacy, state = failure) | yes | Legacy CI support |
| **Events authored by the agent's own app** | **NO** | Loop prevention |
| `check_run.in_progress` / `queued` | no | Noise — only the final result matters |
| Successful checks | See Q1 | Only if conversation is awake |

## Reverse Lookup (URL → conversationId)

### Normalization Rules:
1. **Lowercase the domain** (case-insensitive).
2. **Strip trailing slashes** from the path.
3. **Convert API URLs to HTML URLs**:
   - GitHub: `https://api.github.com/repos/owner/repo/pulls/123` → `https://github.com/owner/repo/pull/123`
   - GitLab: `https://gitlab.com/api/v4/projects/123/merge_requests/42` → requires mapping project ID to owner/repo (complex — defer to HTML URL storage).

### Owner Scoping (Security):
- `findConversationByLink(url, owner?)` — when `owner` is provided, only return conversations owned by that user.
- This prevents cross-tenant leaks (PR #318 shape).
- The webhook handler should resolve the GitHub user → Scooter owner (via `identity_resolve`) and pass it to the lookup.

### Collision Handling:
- Two conversations linking to the same PR → notify both (Q2).
- Use `findAllConversationsByLink()` to get all matching conversations.

## Future Enhancements

1. **Per-conversation notification preferences** (Q4) — add a UI toggle.
2. **Batched notifications** (Q5) — "CI failed 3 times in the last 5 minutes" instead of 3 separate messages.
3. **GitLab MR routing** — same pattern, different URL normalization.
4. **Jira issue routing** — same pattern, different event shape.
5. **Slack thread routing** — already partially implemented; consolidate with this pattern.
