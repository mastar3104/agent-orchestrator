import type {
  ApiResponse,
  GetRoleToolsResponse,
  UpdateRoleToolsRequest,
  UpdateRoleToolsResponse,
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

export async function getRoleTools(): Promise<GetRoleToolsResponse> {
  return request<GetRoleToolsResponse>('/settings/role-tools');
}

export async function updateRoleTools(
  data: UpdateRoleToolsRequest
): Promise<UpdateRoleToolsResponse> {
  return request<UpdateRoleToolsResponse>('/settings/role-tools', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
