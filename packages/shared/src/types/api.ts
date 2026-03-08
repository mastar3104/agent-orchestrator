import type { ItemConfig, ItemSummary, ItemDetail } from './item';
import type { Plan } from './plan';
import type { AgentInfo } from './agent';
import type { ItemEvent } from './events';

// Repository configuration for direct input
export interface RepositoryConfig {
  type: 'remote' | 'local';
  url?: string;              // remoteの場合
  localPath?: string;        // localの場合
  branch?: string;           // clone元ブランチ（デフォルト: main）
  workBranch?: string;       // 作業用ブランチ名（指定時は自動作成）
  submodules?: boolean;
  linkMode?: 'symlink' | 'copy';  // localの場合のモード
  /** エージェントに追加で許可するツール。危険なコマンドも設定可能な自己責任項目。 */
  allowedTools?: string[];
  hooks?: string[];
}

export interface CreateItemRepositoryInput {
  repositoryId?: string;
  repository?: RepositoryConfig;
  name: string;              // ディレクトリ名
  branch?: string;
  workBranch?: string;
  saveRepository?: boolean;
  repositoryName?: string;
  /** エージェントに追加で許可するツール。危険なコマンドも設定可能な自己責任項目。 */
  allowedTools?: string[];
}

// Request types
export interface CreateItemRequest {
  name: string;
  description: string;
  repositories: CreateItemRepositoryInput[];  // 変更: 配列
  designDoc?: string;
}

export interface SendInputRequest {
  input: string;
}

export interface ApprovalDecisionRequest {
  decision: 'approve' | 'deny';
  reason?: string;
}

export interface UpdatePlanRequest {
  content: string;
}

export interface PlanFeedbackItem {
  taskId: string;
  feedback: string;
}

export interface PlanFeedbackRequest {
  feedbacks: PlanFeedbackItem[];
}

export type StartWorkersMode = 'all' | 'retry_failed';

export interface StartWorkersRequest {
  repos?: string[];
  mode?: StartWorkersMode;
}

// Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface CreateItemResponse {
  item: ItemConfig;
}

export interface ListItemsResponse {
  items: ItemSummary[];
}

export interface GetItemResponse {
  item: ItemDetail;
}

export interface AgentStatusResponse {
  agent: AgentInfo;
}

export interface UpdatePlanResponse {
  plan: Plan;
  content: string;
}

// WebSocket message types
export type WsMessageType =
  | 'subscribe'
  | 'unsubscribe'
  | 'event'
  | 'error'
  | 'connected';

export interface WsMessage {
  type: WsMessageType;
  itemId?: string;
  event?: ItemEvent;
  error?: string;
}

export interface WsSubscribeMessage {
  type: 'subscribe';
  itemId: string;
}

export interface WsUnsubscribeMessage {
  type: 'unsubscribe';
  itemId: string;
}

export interface WsEventMessage {
  type: 'event';
  itemId: string;
  event: ItemEvent;
}
