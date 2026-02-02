export interface GitRepository {
  id: string;              // REPO-xxxxxxxx
  name: string;            // 表示名
  type: 'remote' | 'local';
  url?: string;            // remote用
  localPath?: string;      // local用
  branch?: string;         // デフォルトブランチ
  submodules?: boolean;
  linkMode?: 'symlink' | 'copy';
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
}

export interface UpdateRepositoryRequest {
  name?: string;
  branch?: string;
  submodules?: boolean;
  linkMode?: 'symlink' | 'copy';
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
