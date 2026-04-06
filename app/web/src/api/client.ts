import type {
  ApiResponse,
  AgentExecutionOutput,
  CreateItemRequest,
  CreateItemResponse,
  ListItemsResponse,
  GetItemResponse,
  StartWorkersRequest,
  ItemConfig,
  UpdatePlanRequest,
  UpdatePlanResponse,
  GetPlanContentResponse,
  GetTestPlanContentResponse,
  UpdateTestPlanRequest,
  UpdateTestPlanResponse,
  TestPlanApprovalResponse,
  StartAsyncResponse,
  TestPlanFeedbackItem,
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

// Planner
export async function startPlanner(itemId: string): Promise<StartAsyncResponse> {
  return request<StartAsyncResponse>(`/items/${itemId}/planner/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getPlanContent(
  itemId: string
): Promise<GetPlanContentResponse> {
  return request<GetPlanContentResponse>(`/items/${itemId}/plan/content`);
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
): Promise<StartAsyncResponse> {
  return request<StartAsyncResponse>(`/items/${itemId}/workers/start`, {
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

// Plan Feedback
export async function submitPlanFeedback(
  itemId: string,
  feedbacks: { taskId: string; feedback: string }[]
): Promise<StartAsyncResponse> {
  return request<StartAsyncResponse>(
    `/items/${itemId}/plan/feedback`,
    {
      method: 'POST',
      body: JSON.stringify({ feedbacks }),
    }
  );
}

export async function startTestPlanner(itemId: string): Promise<StartAsyncResponse> {
  return request<StartAsyncResponse>(`/items/${itemId}/test-planner/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getTestPlanContent(
  itemId: string
): Promise<GetTestPlanContentResponse> {
  return request<GetTestPlanContentResponse>(`/items/${itemId}/test-plan/content`);
}

export async function updateTestPlan(
  itemId: string,
  data: UpdateTestPlanRequest
): Promise<UpdateTestPlanResponse> {
  return request<UpdateTestPlanResponse>(`/items/${itemId}/test-plan`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function submitTestPlanFeedback(
  itemId: string,
  feedbacks: TestPlanFeedbackItem[]
): Promise<StartAsyncResponse> {
  return request<StartAsyncResponse>(`/items/${itemId}/test-plan/feedback`, {
    method: 'POST',
    body: JSON.stringify({ feedbacks }),
  });
}

export async function approveTestPlan(
  itemId: string
): Promise<TestPlanApprovalResponse> {
  return request<TestPlanApprovalResponse>(`/items/${itemId}/test-plan/approve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function startCompletedReview(
  itemId: string
): Promise<StartAsyncResponse> {
  return request<StartAsyncResponse>(`/items/${itemId}/completed-review/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// Review Receive
export async function startReviewReceive(
  itemId: string,
  repoName?: string
): Promise<StartAsyncResponse> {
  return request<StartAsyncResponse>(
    `/items/${itemId}/review-receive/start`,
    {
      method: 'POST',
      body: JSON.stringify({ repoName }),
    }
  );
}

// Setup Commands
export async function updateRepoSetup(
  itemId: string,
  repoName: string,
  setup: string[]
): Promise<{ item: ItemConfig }> {
  return request<{ item: ItemConfig }>(
    `/items/${encodeURIComponent(itemId)}/repositories/${encodeURIComponent(repoName)}/setup`,
    {
      method: 'PATCH',
      body: JSON.stringify({ setup }),
    }
  );
}

export async function runRepoSetup(
  itemId: string,
  repoName: string
): Promise<StartAsyncResponse> {
  return request<StartAsyncResponse>(
    `/items/${encodeURIComponent(itemId)}/repositories/${encodeURIComponent(repoName)}/setup/run`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
}
