export interface PlanTask {
  id: string;
  title: string;
  description: string;
  agent: string;
  repository: string;       // どのリポジトリのタスクか
  dependencies?: string[];
  files?: string[];
}

export interface Plan {
  version: string;
  itemId: string;
  summary: string;
  tasks: PlanTask[];
  createdAt: string;
}

export interface PlannerPromptContext {
  itemConfig: import('./item').ItemConfig;
  designDoc: string;
  repoStructure?: string;
}
