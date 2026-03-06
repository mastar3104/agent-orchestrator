// ─── Response Interfaces ───

export interface PlannerResponse {
  status: 'success' | 'failure';
  summary: string;
}

export interface EngineerResponse {
  status: 'success' | 'failure';
  files_modified: string[];
  commit_message?: string;
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
    files_modified: { type: 'array', items: { type: 'string' } },
    commit_message: { type: 'string' },
  },
  required: ['status', 'files_modified'],
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

// ─── Schema Registry (for role-loader) ───

export const SCHEMA_REGISTRY: Record<string, object> = {
  planner: PLANNER_RESPONSE_SCHEMA,
  engineer: ENGINEER_RESPONSE_SCHEMA,
  reviewer: REVIEWER_RESPONSE_SCHEMA,
  reviewReceiver: REVIEW_RECEIVER_RESPONSE_SCHEMA,
};
