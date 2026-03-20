// ─── Response Interfaces ───

export interface PlannerResponse {
  status: 'success' | 'failure';
  summary: string;
}

export type TestPlannerResponse = PlannerResponse;
export interface CompletedReviewerResponse {
  review_status: 'approve' | 'needs_fixes';
  summary: string;
  findings: Array<{
    id: string;
    scenarioId: string;
    targetRepository: string;
    relatedRepositories: string[];
    severity: 'critical' | 'major' | 'minor';
    summary: string;
    details: string;
    suggestedFix: string;
  }>;
}

export interface EngineerResponse {
  status: 'success' | 'failure';
}

export interface ReviewComment {
  file: string;
  comment: string;
  severity?: 'critical' | 'major' | 'minor';
  line?: number;
  suggestedFix?: string;
}

export interface ReviewerResponse {
  review_status: 'approve' | 'request_changes';
  comments: ReviewComment[];
}

export type ReviewReceiverResponse = PlannerResponse;

// ─── JSON Schemas ───

export const PLANNER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['success', 'failure'] },
    summary: { type: 'string' },
  },
  required: ['status', 'summary'],
};

export const ENGINEER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['success', 'failure'] },
  },
  required: ['status'],
};

export const REVIEWER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    review_status: { type: 'string', enum: ['approve', 'request_changes'] },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          comment: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          line: { type: 'number' },
          suggestedFix: { type: 'string' },
        },
        required: ['file', 'comment'],
      },
    },
  },
  required: ['review_status', 'comments'],
};

export const REVIEW_RECEIVER_RESPONSE_SCHEMA = PLANNER_RESPONSE_SCHEMA;
export const TEST_PLANNER_RESPONSE_SCHEMA = PLANNER_RESPONSE_SCHEMA;
export const COMPLETED_REVIEWER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    review_status: { type: 'string', enum: ['approve', 'needs_fixes'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          scenarioId: { type: 'string' },
          targetRepository: { type: 'string' },
          relatedRepositories: {
            type: 'array',
            items: { type: 'string' },
          },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          summary: { type: 'string' },
          details: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: [
          'id',
          'scenarioId',
          'targetRepository',
          'relatedRepositories',
          'severity',
          'summary',
          'details',
          'suggestedFix',
        ],
      },
    },
  },
  required: ['review_status', 'summary', 'findings'],
};

// ─── Schema Registry (for role-loader) ───

export const SCHEMA_REGISTRY: Record<string, object> = {
  planner: PLANNER_RESPONSE_SCHEMA,
  testPlanner: TEST_PLANNER_RESPONSE_SCHEMA,
  completedReviewer: COMPLETED_REVIEWER_RESPONSE_SCHEMA,
  engineer: ENGINEER_RESPONSE_SCHEMA,
  reviewer: REVIEWER_RESPONSE_SCHEMA,
  reviewReceiver: REVIEW_RECEIVER_RESPONSE_SCHEMA,
};
