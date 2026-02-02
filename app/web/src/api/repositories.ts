import type {
  ApiResponse,
  GitRepository,
  CreateRepositoryRequest,
  UpdateRepositoryRequest,
  ListRepositoriesResponse,
  GetRepositoryResponse,
  CreateRepositoryResponse,
  UpdateRepositoryResponse,
  DeleteRepositoryResponse,
} from '@agent-orch/shared';

const API_BASE = '/api';

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const headers: Record<string, string> = {
    ...options?.headers as Record<string, string>,
  };

  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const data = (await response.json()) as ApiResponse<T>;

  if (!data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data.data as T;
}

export async function listRepositories(): Promise<ListRepositoriesResponse> {
  return request<ListRepositoriesResponse>('/repositories');
}

export async function getRepository(id: string): Promise<GetRepositoryResponse> {
  return request<GetRepositoryResponse>(`/repositories/${id}`);
}

export async function createRepository(
  data: CreateRepositoryRequest
): Promise<CreateRepositoryResponse> {
  return request<CreateRepositoryResponse>('/repositories', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateRepository(
  id: string,
  data: UpdateRepositoryRequest
): Promise<UpdateRepositoryResponse> {
  return request<UpdateRepositoryResponse>(`/repositories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteRepository(
  id: string
): Promise<DeleteRepositoryResponse> {
  return request<DeleteRepositoryResponse>(`/repositories/${id}`, {
    method: 'DELETE',
  });
}
