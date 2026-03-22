import type { Plan, TestPlan, VerificationPolicy } from '@agent-orch/shared';
import { getVerificationPolicyRank } from '@agent-orch/shared';

const LEGACY_NON_EMPTY_PLAN_RATIONALE =
  'Legacy plan without verificationPolicy; defaulted to bdd_required for safety.';

const EMPTY_PLAN_RATIONALE =
  'No implementation tasks are planned, so additional verification scenarios are not required.';

function isVerificationPolicy(value: unknown): value is VerificationPolicy {
  return value === 'none' || value === 'regression_only' || value === 'bdd_required';
}

export function normalizePlanVerificationPolicy(
  policy: unknown,
  taskCount: number
): VerificationPolicy {
  if (taskCount === 0) {
    return 'none';
  }
  if (isVerificationPolicy(policy)) {
    return policy;
  }
  return 'bdd_required';
}

export function normalizePlanVerificationRationale(
  rationale: unknown,
  policy: VerificationPolicy,
  taskCount: number
): string {
  if (typeof rationale === 'string' && rationale.trim()) {
    return rationale.trim();
  }
  if (taskCount === 0 || policy === 'none') {
    return EMPTY_PLAN_RATIONALE;
  }
  return LEGACY_NON_EMPTY_PLAN_RATIONALE;
}

export function normalizePlanVerification(plan: Pick<Plan, 'tasks'> & Partial<Plan>): Pick<Plan, 'verificationPolicy' | 'verificationRationale'> {
  const taskCount = Array.isArray(plan.tasks) ? plan.tasks.length : 0;
  const verificationPolicy = normalizePlanVerificationPolicy(plan.verificationPolicy, taskCount);
  return {
    verificationPolicy,
    verificationRationale: normalizePlanVerificationRationale(
      plan.verificationRationale,
      verificationPolicy,
      taskCount
    ),
  };
}

export function normalizeTestPlanVerification(
  testPlan: Partial<TestPlan>,
  plan: Pick<Plan, 'verificationPolicy' | 'verificationRationale' | 'tasks'>
): Pick<TestPlan, 'verificationPolicy' | 'verificationRationale'> {
  const taskCount = Array.isArray(plan.tasks) ? plan.tasks.length : 0;
  const minimumPolicy = normalizePlanVerificationPolicy(plan.verificationPolicy, taskCount);
  const candidatePolicy = normalizePlanVerificationPolicy(testPlan.verificationPolicy, taskCount);
  const verificationPolicy = getVerificationPolicyRank(candidatePolicy) < getVerificationPolicyRank(minimumPolicy)
    ? minimumPolicy
    : candidatePolicy;

  return {
    verificationPolicy,
    verificationRationale: normalizePlanVerificationRationale(
      testPlan.verificationRationale ?? plan.verificationRationale,
      verificationPolicy,
      taskCount
    ),
  };
}

export function isCompletedReviewRequired(policy: VerificationPolicy): boolean {
  return policy === 'bdd_required';
}

export function shouldAutoApproveTestPlan(policy: VerificationPolicy): boolean {
  return policy === 'none';
}
