# Dead Code Audit

Date: 2026-03-20

## Removed in pass 1

- Unused web API wrappers removed from `app/web/src/api/client.ts`: `retryClone`, `getPlan`, `getTestPlan`, `getCompletedReview`
- Unused repository detail client/hook removed from `app/web/src/api/repositories.ts` and `app/web/src/hooks/useRepositories.ts`
- Unused internal server helpers/exports removed from:
  - `app/server/src/lib/claude-executor.ts`
  - `app/server/src/lib/jsonl.ts`
  - `app/server/src/services/agent-service.ts`
  - `app/server/src/services/completed-review-service.ts`
  - `app/server/src/services/git-snapshot-service.ts`
  - `app/server/src/services/state-service.ts`
  - `app/server/src/services/worker-service.ts`
- Remaining `tsc --noUnusedLocals --noUnusedParameters` issues in server/web/test code were cleaned up as part of the same pass.

## Deferred legacy candidates

These are strong dead-code candidates but were intentionally kept for compatibility.

- Approval compatibility layer:
  - `app/server/src/services/state-service.ts#getPendingApprovals` is deprecated and always returns an empty array.
  - `pendingApprovals` fields and approval-related event types/rendering remain in place for now.
- Output event compatibility layer:
  - Current runtime persists agent output to `output.json`.
  - Legacy `stdout` / `stderr` event types and related helpers were not removed in this pass.

## Guardrails for the next pass

- Do not remove persisted event schemas without checking existing item event logs.
- Do not remove server HTTP routes unless usage outside the bundled web client has been ruled out.
