export interface PlanTask {
  id: string;
  title: string;
  description: string;
  repository: string;       // どのリポジトリのタスクか
  dependencies?: string[];
  files?: string[];
}

export interface Plan {
  version: string;
  itemId: string;
  summary: string;
  tasks: PlanTask[];
  createdAt: string;
}

export type TestPlanScenarioKind = 'bdd' | 'regression';

export interface TestPlanScenario {
  id: string;
  kind: TestPlanScenarioKind;
  title: string;
  repositories: string[];
  given: string;
  when: string;
  then: string;
}

export interface TestPlan {
  version: string;
  itemId: string;
  planFingerprint: string;
  summary: string;
  scenarios: TestPlanScenario[];
  createdAt: string;
}

export type TestPlanApprovalStatus = 'missing' | 'stale' | 'pending' | 'approved';

export interface TestPlanApprovalState {
  status: TestPlanApprovalStatus;
  planFingerprint?: string;
  testPlanFingerprint?: string;
  approvedAt?: string;
  approvedBy?: 'user' | 'auto';
}

export type CompletedReviewFindingSeverity = 'critical' | 'major' | 'minor';

export interface CompletedReviewFinding {
  id: string;
  scenarioId: string;
  targetRepository: string;
  relatedRepositories: string[];
  severity: CompletedReviewFindingSeverity;
  summary: string;
  details: string;
  suggestedFix: string;
}

export interface CompletedReviewResult {
  status: 'needs_fixes' | 'passed';
  summary: string;
  findings: CompletedReviewFinding[];
  round: number;
  reviewedAt: string;
}

export type CompletedReviewStatus =
  | 'not_started'
  | 'running'
  | 'needs_fixes'
  | 'passed'
  | 'error';

export interface CompletedReviewState {
  status: CompletedReviewStatus;
  summary?: string;
  findings: CompletedReviewFinding[];
  round?: number;
  updatedAt?: string;
  errorMessage?: string;
}

export interface PlannerPromptContext {
  itemConfig: import('./item').ItemConfig;
  designDoc: string;
  repoStructure?: string;
}
