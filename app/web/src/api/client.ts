import type {
  ApiResponse,
  CreateItemRequest,
  CreateItemResponse,
  ListItemsResponse,
  GetItemResponse,
  StartAgentRequest,
  StartAgentResponse,
  ApprovalDecisionRequest,
  ApprovalRequestEvent,
  Plan,
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
export async function startWorkers(itemId: string): Promise<{ started: boolean }> {
  return request<{ started: boolean }>(`/items/${itemId}/workers/start`, {
    method: 'POST',
    body: JSON.stringify({}),
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
export async function startAgent(
  itemId: string,
  data: StartAgentRequest
): Promise<StartAgentResponse> {
  return request<StartAgentResponse>(`/items/${itemId}/agents/start`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

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

export async function sendAgentInput(
  itemId: string,
  agentId: string,
  input: string
): Promise<{ sent: boolean }> {
  return request<{ sent: boolean }>(
    `/items/${itemId}/agents/${agentId}/input`,
    {
      method: 'POST',
      body: JSON.stringify({ input }),
    }
  );
}

export async function getAgentOutput(
  itemId: string,
  agentId: string
): Promise<{ output: string }> {
  return request<{ output: string }>(`/items/${itemId}/agents/${agentId}/output`);
}

export async function resizeAgentTerminal(
  itemId: string,
  agentId: string,
  cols: number,
  rows: number
): Promise<{ resized: boolean }> {
  return request<{ resized: boolean }>(
    `/items/${itemId}/agents/${agentId}/resize`,
    {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    }
  );
}

// Approvals
export async function getPendingApprovals(
  itemId: string
): Promise<{ approvals: ApprovalRequestEvent[] }> {
  return request<{ approvals: ApprovalRequestEvent[] }>(
    `/items/${itemId}/approvals`
  );
}

export async function processApproval(
  itemId: string,
  eventId: string,
  data: ApprovalDecisionRequest
): Promise<{ processed: boolean }> {
  return request<{ processed: boolean }>(
    `/items/${itemId}/approval/${eventId}`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
}

export async function batchProcessApprovals(
  itemId: string,
  decision: 'approve' | 'deny',
  reason?: string
): Promise<{ processed: number }> {
  return request<{ processed: number }>(`/items/${itemId}/approvals/batch`, {
    method: 'POST',
    body: JSON.stringify({ decision, reason }),
  });
}
