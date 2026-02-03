import { watch, existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { ItemConfig, Plan } from '@agent-orch/shared';
import { startAgent, sendInput, getAgentsByItem } from './agent-service';
import { getItemConfig } from './item-service';
import { readYamlSafe, parseYaml, stringifyYaml } from '../lib/yaml';
import { appendJsonl } from '../lib/jsonl';
import { createPlanCreatedEvent, createStatusChangedEvent } from '../lib/events';
import {
  getItemPlanPath,
  getItemEventsPath,
  getWorkspaceDir,
} from '../lib/paths';
import { eventBus } from './event-bus';

const PLANNER_PROMPT_TEMPLATE = `You are a development planner agent. Your task is to analyze the design document and repository structure, then create a detailed implementation plan.

## Context

**Project Name:** {{name}}
**Description:** {{description}}

**Design Document:**
{{designDoc}}

## Instructions

1. Analyze the design document and understand the requirements
2. Examine the repository structure to understand existing code patterns
3. Break down the implementation into discrete tasks
4. Assign each task to one of three specialized agents:
   - **front**: Frontend development tasks (UI components, styling, client-side logic)
   - **back**: Backend development tasks (APIs, database, server-side logic)
   - **review**: Code review, testing, documentation, integration tasks

## Output

Create a file named \`plan.yaml\` in the current directory with the following structure:

\`\`\`yaml
version: "1.0"
itemId: "{{itemId}}"
summary: "Brief summary of the implementation plan"
tasks:
  - id: "task-1"
    title: "Task title"
    description: "Detailed description of what needs to be done"
    agent: "front|back|review"
    dependencies: []  # Optional: list of task IDs this depends on
    files: []  # Optional: list of files to create/modify
\`\`\`

Focus on creating actionable, well-scoped tasks. Each task should be completable by a single agent in one session.

## CRITICAL CONSTRAINTS

You are a PLANNER, NOT a developer. You MUST NOT:
- Write or modify any code files (only plan.yaml is allowed)
- Implement any features, fixes, or code changes
- Run any build, test, lint, or development commands
- Continue working after plan.yaml is created

Your ONLY job is to:
1. Analyze the design document
2. Examine the repository structure (read-only)
3. Create plan.yaml with implementation tasks
4. Output "TASKS_COMPLETED" on its own line to signal completion
5. STOP and wait for orchestrator to terminate session

IMPORTANT: After creating plan.yaml, you MUST output "TASKS_COMPLETED" on its own line, then STOP working immediately. The orchestrator will automatically terminate this session. Do NOT continue with any implementation, testing, or other actions.`;

export async function startPlanner(itemId: string): Promise<void> {
  const config = await getItemConfig(itemId);
  if (!config) {
    throw new Error(`Item ${itemId} not found`);
  }

  const prompt = buildPlannerPrompt(config);
  const workspaceDir = getWorkspaceDir(itemId);

  // Start watching for plan.yaml creation before starting agent
  watchForPlan(itemId);

  // Start the planner agent
  await startAgent({
    itemId,
    role: 'planner',
    prompt,
    workingDir: workspaceDir,
  });
}

function buildPlannerPrompt(config: ItemConfig): string {
  return PLANNER_PROMPT_TEMPLATE
    .replace('{{name}}', config.name)
    .replace('{{description}}', config.description)
    .replace('{{designDoc}}', config.designDoc || 'No design document provided.')
    .replace('{{itemId}}', config.id);
}

function watchForPlan(itemId: string): void {
  const planPath = getItemPlanPath(itemId);
  const workspaceDir = getWorkspaceDir(itemId);

  // Also check workspace for plan.yaml
  const workspacePlanPath = `${workspaceDir}/plan.yaml`;

  let detected = false;

  const checkAndEmit = async (path: string) => {
    if (detected) return;

    try {
      const content = await readFile(path, 'utf-8');
      const plan = parseYaml<Plan>(content);

      if (plan && plan.tasks && plan.tasks.length > 0) {
        detected = true;

        // Log plan created event
        const event = createPlanCreatedEvent(itemId, path);
        await appendJsonl(getItemEventsPath(itemId), event);
        eventBus.emit('event', { itemId, event });

        // Update planner agent status to completed
        const agents = await getAgentsByItem(itemId);
        const plannerAgent = agents.find(a => a.role === 'planner');
        if (plannerAgent) {
          // Record status_changed event
          const statusEvent = createStatusChangedEvent(
            itemId,
            plannerAgent.status,
            'completed',
            plannerAgent.id
          );
          await appendJsonl(getItemEventsPath(itemId), statusEvent);
          eventBus.emit('event', { itemId, event: statusEvent });

          // Update agent state
          plannerAgent.status = 'completed';
          plannerAgent.stoppedAt = new Date().toISOString();

          // Signal planner agent to exit
          await sendInput(plannerAgent.id, '/exit');
        }
      }
    } catch {
      // File doesn't exist or isn't valid yaml yet
    }
  };

  // Check if plan already exists
  checkAndEmit(planPath);
  checkAndEmit(workspacePlanPath);

  // Watch item directory for plan.yaml
  if (existsSync(workspaceDir)) {
    const watcher = watch(workspaceDir, (eventType, filename) => {
      // 'rename' = file created/deleted, 'change' = file modified
      // Both events should trigger plan detection
      if (filename === 'plan.yaml') {
        checkAndEmit(workspacePlanPath);
      }
    });

    // Auto-close watcher after 30 minutes
    setTimeout(() => {
      watcher.close();
    }, 30 * 60 * 1000);
  }
}

export async function getPlan(itemId: string): Promise<Plan | null> {
  // Check both locations
  let plan = await readYamlSafe<Plan>(getItemPlanPath(itemId));
  if (!plan) {
    plan = await readYamlSafe<Plan>(`${getWorkspaceDir(itemId)}/plan.yaml`);
  }
  return plan;
}

export async function getPlanContent(itemId: string): Promise<string | null> {
  const itemPlanPath = getItemPlanPath(itemId);
  if (existsSync(itemPlanPath)) {
    return readFile(itemPlanPath, 'utf-8');
  }

  const workspacePlanPath = `${getWorkspaceDir(itemId)}/plan.yaml`;
  if (existsSync(workspacePlanPath)) {
    return readFile(workspacePlanPath, 'utf-8');
  }

  return null;
}

export async function updatePlanContent(
  itemId: string,
  content: string
): Promise<{ plan: Plan; content: string }> {
  let plan: Plan;
  try {
    plan = parseYaml<Plan>(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid YAML';
    throw new Error(`Invalid YAML: ${message}`);
  }

  const errors = await validatePlan(plan);
  if (plan.itemId && plan.itemId !== itemId) {
    errors.push(`itemId does not match (${plan.itemId} !== ${itemId})`);
  }

  if (errors.length > 0) {
    throw new Error(`Plan validation failed: ${errors.join('; ')}`);
  }

  const normalized = stringifyYaml(plan);
  const itemPlanPath = getItemPlanPath(itemId);
  const workspacePlanPath = `${getWorkspaceDir(itemId)}/plan.yaml`;

  await mkdir(dirname(itemPlanPath), { recursive: true });
  await writeFile(itemPlanPath, normalized, 'utf-8');

  if (existsSync(getWorkspaceDir(itemId))) {
    await writeFile(workspacePlanPath, normalized, 'utf-8');
  }

  return { plan, content: normalized };
}

export async function validatePlan(plan: Plan): Promise<string[]> {
  const errors: string[] = [];

  if (!plan.version) {
    errors.push('Missing version field');
  }

  if (!plan.itemId) {
    errors.push('Missing itemId field');
  }

  if (!plan.tasks || !Array.isArray(plan.tasks)) {
    errors.push('Missing or invalid tasks array');
    return errors;
  }

  const taskIds = new Set<string>();

  for (const task of plan.tasks) {
    if (!task.id) {
      errors.push('Task missing id field');
    } else if (taskIds.has(task.id)) {
      errors.push(`Duplicate task id: ${task.id}`);
    } else {
      taskIds.add(task.id);
    }

    if (!task.title) {
      errors.push(`Task ${task.id || 'unknown'} missing title`);
    }

    if (!task.agent || !['front', 'back', 'review'].includes(task.agent)) {
      errors.push(`Task ${task.id || 'unknown'} has invalid agent: ${task.agent}`);
    }

    if (task.dependencies) {
      for (const dep of task.dependencies) {
        if (!taskIds.has(dep) && !plan.tasks.some((t) => t.id === dep)) {
          errors.push(`Task ${task.id} depends on non-existent task: ${dep}`);
        }
      }
    }
  }

  return errors;
}
