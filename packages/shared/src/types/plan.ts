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

export interface PlannerPromptContext {
  itemConfig: import('./item').ItemConfig;
  designDoc: string;
  repoStructure?: string;
}
