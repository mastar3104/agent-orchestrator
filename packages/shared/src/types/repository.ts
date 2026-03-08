export interface GitRepository {
  id: string;              // REPO-xxxxxxxx
  name: string;            // 表示名
  type: 'remote' | 'local';
  url?: string;            // remote用
  localPath?: string;      // local用
  branch?: string;         // デフォルトブランチ
  submodules?: boolean;
  linkMode?: 'symlink' | 'copy';
  directoryName?: string;  // ディレクトリ名 (e.g., "frontend")
  /** エージェントに追加で許可するツール。危険なコマンドも設定可能な自己責任項目。 */
  allowedTools?: string[];
  /** Engineer完了後に順次実行するバリデーションコマンド。失敗時は自動修正を試みる。 */
  hooks?: string[];
  /** hooks の初回実行を含む最大試行回数。saved repository YAML からのみ注入する。 */
  hooksMaxAttempts?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepositoryRequest {
  name: string;
  type: 'remote' | 'local';
  url?: string;
  localPath?: string;
  branch?: string;
  submodules?: boolean;
  linkMode?: 'symlink' | 'copy';
  directoryName?: string;
  /** エージェントに追加で許可するツール。危険なコマンドも設定可能な自己責任項目。 */
  allowedTools?: string[];
  hooks?: string[];
}

export interface UpdateRepositoryRequest {
  name?: string;
  branch?: string;
  submodules?: boolean;
  linkMode?: 'symlink' | 'copy';
  directoryName?: string;
  /** エージェントに追加で許可するツール。危険なコマンドも設定可能な自己責任項目。 */
  allowedTools?: string[];
  hooks?: string[];
}

// API Response types
export interface ListRepositoriesResponse {
  repositories: GitRepository[];
}

export interface GetRepositoryResponse {
  repository: GitRepository;
}

export interface CreateRepositoryResponse {
  repository: GitRepository;
}

export interface UpdateRepositoryResponse {
  repository: GitRepository;
}

export interface DeleteRepositoryResponse {
  deleted: boolean;
}
