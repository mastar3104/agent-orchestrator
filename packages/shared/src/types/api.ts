import type { ItemConfig, ItemSummary, ItemDetail } from './item';
import type { AgentInfo, AgentRole } from './agent';
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
}

// Request types
export interface CreateItemRequest {
  name: string;
  description: string;
  repositoryId?: string;     // 登録済みリポジトリID（新規追加）
  repository?: RepositoryConfig;  // 直接入力（従来通り）
  branch?: string;           // Clone branch override for saved repo
  workBranch?: string;       // Item固有の作業ブランチ（repositoryId使用時）
  saveRepository?: boolean;  // 手入力時にリポジトリを保存するか
  repositoryName?: string;   // 保存時のリポジトリ名
  designDoc?: string;
}

export interface StartAgentRequest {
  role: AgentRole;
  prompt?: string;
}

export interface SendInputRequest {
  input: string;
}

export interface ApprovalDecisionRequest {
  decision: 'approve' | 'deny';
  reason?: string;
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

export interface StartAgentResponse {
  agent: AgentInfo;
}

export interface AgentStatusResponse {
  agent: AgentInfo;
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
