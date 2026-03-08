import type {
  ApiResponse,
  AgentExecutionOutput,
  CreateItemRequest,
  CreateItemResponse,
  ListItemsResponse,
  GetItemResponse,
  Plan,
  StartWorkersRequest,
  ItemConfig,
  UpdatePlanRequest,
  UpdatePlanResponse,
} from '@agent-orch/shared';

const API_BASE = '/api';

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const headers: Record<string, string> = {
    ...options?.headers as Record<string, string>,
  };

  // Only set Content-Type if there's a body
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

// Items
export async function createItem(
  data: CreateItemRequest
): Promise<CreateItemResponse> {
  return request<CreateItemResponse>('/items', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function listItems(): Promise<ListItemsResponse> {
  return request<ListItemsResponse>('/items');
}

export async function getItem(id: string): Promise<GetItemResponse> {
  return request<GetItemResponse>(`/items/${id}`);
}

export async function updateItem(
  id: string,
  data: Partial<Pick<ItemConfig, 'name' | 'description' | 'designDoc'>>
): Promise<{ item: ItemConfig }> {
  return request<{ item: ItemConfig }>(`/items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteItem(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/items/${id}`, {
    method: 'DELETE',
  });
}

export async function retryClone(id: string): Promise<{ started: boolean }> {
  return request<{ started: boolean }>(`/items/${id}/clone`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// Planner
export async function startPlanner(itemId: string): Promise<{ started: boolean }> {
  return request<{ started: boolean }>(`/items/${itemId}/planner/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getPlan(itemId: string): Promise<{ plan: Plan | null }> {
  return request<{ plan: Plan | null }>(`/items/${itemId}/plan`);
}

export async function getPlanContent(
  itemId: string
): Promise<{ content: string | null }> {
  return request<{ content: string | null }>(`/items/${itemId}/plan/content`);
}

export async function updatePlan(
  itemId: string,
  data: UpdatePlanRequest
): Promise<UpdatePlanResponse> {
  return request<UpdatePlanResponse>(`/items/${itemId}/plan`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// Workers
export async function startWorkers(
  itemId: string,
  data: StartWorkersRequest = {}
): Promise<{ started: boolean }> {
  return request<{ started: boolean }>(`/items/${itemId}/workers/start`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getWorkerStatus(
  itemId: string
): Promise<{ workers: { role: string; taskCount: number; status: string }[] }> {
  return request<{
    workers: { role: string; taskCount: number; status: string }[];
  }>(`/items/${itemId}/workers/status`);
}

// Agents
export async function stopAgent(
  itemId: string,
  agentId: string
): Promise<{ stopped: boolean }> {
  return request<{ stopped: boolean }>(
    `/items/${itemId}/agents/${agentId}/stop`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
}

// Agent Output
export async function getAgentOutput(
  itemId: string,
  agentId: string
): Promise<{ output: AgentExecutionOutput | null }> {
  return request<{ output: AgentExecutionOutput | null }>(
    `/items/${itemId}/agents/${agentId}/output`
  );
}

// Settings — Roles
export async function getRolesYaml(): Promise<{ content: string; isLocal: boolean }> {
  return request<{ content: string; isLocal: boolean }>('/settings/roles');
}

export async function updateRolesYaml(content: string): Promise<{ content: string; isLocal: boolean }> {
  return request<{ content: string; isLocal: boolean }>('/settings/roles', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

export async function deleteLocalRolesYaml(): Promise<{ content: string; isLocal: boolean }> {
  return request<{ content: string; isLocal: boolean }>('/settings/roles/local', {
    method: 'DELETE',
  });
}

// Plan Feedback
export async function submitPlanFeedback(
  itemId: string,
  feedbacks: { taskId: string; feedback: string }[]
): Promise<{ started: boolean }> {
  return request<{ started: boolean }>(
    `/items/${itemId}/plan/feedback`,
    {
      method: 'POST',
      body: JSON.stringify({ feedbacks }),
    }
  );
}

// Review Receive
export async function startReviewReceive(
  itemId: string,
  repoName?: string
): Promise<{ started: boolean }> {
  return request<{ started: boolean }>(
    `/items/${itemId}/review-receive/start`,
    {
      method: 'POST',
      body: JSON.stringify({ repoName }),
    }
  );
}
