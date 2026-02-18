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
  role?: string;           // 開発エージェントの役割 (e.g., "front")
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
  role?: string;
}

export interface UpdateRepositoryRequest {
  name?: string;
  branch?: string;
  submodules?: boolean;
  linkMode?: 'symlink' | 'copy';
  directoryName?: string;
  role?: string;
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
