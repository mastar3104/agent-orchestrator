import { watch, existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { ItemConfig, Plan } from '@agent-orch/shared';
import { startAgent, sendLine, getAgentsByItem } from './agent-service';
import { getItemConfig } from './item-service';
import { readYamlSafe, parseYaml, stringifyYaml } from '../lib/yaml';
import { appendJsonl } from '../lib/jsonl';
import { createPlanCreatedEvent, createStatusChangedEvent, createErrorEvent } from '../lib/events';
import {
  getItemPlanPath,
  getItemEventsPath,
  getWorkspaceRoot,
} from '../lib/paths';
import { eventBus } from './event-bus';

const PLANNER_PROMPT_TEMPLATE = `You are a development planner agent. Your task is to analyze the design document and repository structure, then create a detailed implementation plan.

## Context

**Project Name:** {{name}}
**Description:** {{description}}

**Repositories:**
{{repositories}}

**Design Document:**
{{designDoc}}

## Instructions

1. Analyze the design document and understand the requirements
2. Examine ALL repository directories in the workspace to understand existing code patterns
3. Break down the implementation into discrete tasks
4. Assign each task to the appropriate repository with the \`repository\` field matching a repository name
5. Assign each task to the appropriate agent role

## Available Repositories and Roles

{{repoRoleMapping}}

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
    agent: "<role>"          # One of the roles listed above
    repository: "<repoName>" # One of the repository names listed above
    dependencies: []  # Optional: list of task IDs this depends on
    files: []  # Optional: list of files to create/modify
\`\`\`

IMPORTANT: Every task MUST have a \`repository\` field matching one of the repository names listed above.

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
  // Check for existing planner (allow restart from error/stopped)
  const agents = await getAgentsByItem(itemId);
  const existingPlanner = agents.find(a => a.role === 'planner');
  if (existingPlanner) {
    // error/stopped are restartable, others should be skipped
    if (existingPlanner.status !== 'error' && existingPlanner.status !== 'stopped') {
      console.log(`[${itemId}] Planner already exists (status: ${existingPlanner.status}), skipping`);
      return;
    }
    console.log(`[${itemId}] Restarting planner (previous status: ${existingPlanner.status})`);
  }

  const config = await getItemConfig(itemId);
  if (!config) {
    throw new Error(`Item ${itemId} not found`);
  }

  const prompt = buildPlannerPrompt(config);
  const workspaceRoot = getWorkspaceRoot(itemId);

  // Start watching for plan.yaml creation before starting agent
  watchForPlan(itemId);

  // Start the planner agent (planner works from workspace root, no repoName needed)
  await startAgent({
    itemId,
    role: 'planner',
    prompt,
    workingDir: workspaceRoot,
  });
}

function buildPlannerPrompt(config: ItemConfig): string {
  const repoList = config.repositories
    .map(r => `- **${r.name}** (role: ${r.role}, type: ${r.type})`)
    .join('\n');

  const repoRoleMapping = config.repositories
    .map(r => `- Repository: \`${r.name}\` → Agent role: \`${r.role}\``)
    .join('\n');

  return PLANNER_PROMPT_TEMPLATE
    .replace('{{name}}', config.name)
    .replace('{{description}}', config.description)
    .replace('{{designDoc}}', config.designDoc || 'No design document provided.')
    .replace('{{itemId}}', config.id)
    .replace('{{repositories}}', repoList)
    .replace('{{repoRoleMapping}}', repoRoleMapping);
}

/**
 * Watch for plan.yaml creation and emit plan_created event
 * @param itemId - The item ID to watch
 * @param targetRole - The agent role that creates the plan (default: 'planner')
 * @param agentId - Optional agent ID to monitor for exit without plan creation
 */
export function watchForPlan(
  itemId: string,
  targetRole: 'planner' | 'review-receiver' = 'planner',
  agentId?: string
): void {
  const planPath = getItemPlanPath(itemId);
  const workspaceRoot = getWorkspaceRoot(itemId);

  let detected = false;
  let cleaned = false;
  let pendingCheck: Promise<void> = Promise.resolve();

  const cleanup = (watcher: ReturnType<typeof watch> | null, pollInterval: ReturnType<typeof setInterval>, unsubscribe?: () => void) => {
    if (cleaned) return;
    cleaned = true;
    watcher?.close();
    clearInterval(pollInterval);
    unsubscribe?.();
  };

  const checkAndEmit = (path: string) => {
    pendingCheck = pendingCheck.then(async () => {
      if (detected) return;

      try {
        const content = await readFile(path, 'utf-8');
        const plan = parseYaml<Plan>(content);

        if (plan && plan.tasks) {
          detected = true;

          // Log plan created event
          const event = createPlanCreatedEvent(itemId, path);
          await appendJsonl(getItemEventsPath(itemId), event);
          eventBus.emit('event', { itemId, event });

          // Update target agent status to completed
          const agents = await getAgentsByItem(itemId);
          const targetAgent = agents.find(a => a.role === targetRole && a.status === 'running')
            ?? [...agents].reverse().find(a => a.role === targetRole);
          if (targetAgent) {
            // Record status_changed event
            const statusEvent = createStatusChangedEvent(
              itemId,
              targetAgent.status,
              'completed',
              targetAgent.id
            );
            await appendJsonl(getItemEventsPath(itemId), statusEvent);
            eventBus.emit('event', { itemId, event: statusEvent });

            // Update agent state
            targetAgent.status = 'completed';
            targetAgent.stoppedAt = new Date().toISOString();

            // Signal target agent to exit
            await sendLine(targetAgent.id, '/exit');
          }
        }
      } catch {
        // File doesn't exist or isn't valid yaml yet
      }
    });
  };

  // Check if plan already exists
  checkAndEmit(planPath);

  // Watch workspace root for plan.yaml
  let watcher: ReturnType<typeof watch> | null = null;
  if (existsSync(workspaceRoot)) {
    watcher = watch(workspaceRoot, (eventType, filename) => {
      if (filename === 'plan.yaml') {
        checkAndEmit(planPath);
      }
    });
  }

  // Polling fallback: fs.watch can be unreliable on macOS + symlink environments
  const pollInterval = setInterval(() => {
    if (detected) {
      clearInterval(pollInterval);
      return;
    }
    checkAndEmit(planPath);
  }, 3000);

  // Listen for agent exit to detect plan-less termination
  let unsubscribe: (() => void) | undefined;
  if (agentId) {
    unsubscribe = eventBus.subscribeToItem(itemId, (event) => {
      if (detected) return;
      if (event.type === 'agent_exited' && event.agentId === agentId) {
        // Agent exited without plan detection — give 5s grace period for pending file writes
        setTimeout(async () => {
          if (detected) return;

          // Final check
          checkAndEmit(planPath);
          await pendingCheck;
          if (detected) return;

          // Plan was not created — emit error event
          const errorEvent = createErrorEvent(
            itemId,
            `${targetRole} agent exited without creating plan.yaml`,
            undefined,
            agentId
          );
          await appendJsonl(getItemEventsPath(itemId), errorEvent);
          eventBus.emit('event', { itemId, event: errorEvent });

          cleanup(watcher, pollInterval, unsubscribe);
        }, 5000);
      }
    });
  }

  // Auto-close watcher and polling after 30 minutes
  setTimeout(() => {
    cleanup(watcher, pollInterval, unsubscribe);
  }, 30 * 60 * 1000);
}

export async function getPlan(itemId: string): Promise<Plan | null> {
  return readYamlSafe<Plan>(getItemPlanPath(itemId));
}

export async function getPlanContent(itemId: string): Promise<string | null> {
  const planPath = getItemPlanPath(itemId);
  if (existsSync(planPath)) {
    return readFile(planPath, 'utf-8');
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

  const config = await getItemConfig(itemId);
  const errors = await validatePlan(plan, config);
  if (plan.itemId && plan.itemId !== itemId) {
    errors.push(`itemId does not match (${plan.itemId} !== ${itemId})`);
  }

  if (errors.length > 0) {
    throw new Error(`Plan validation failed: ${errors.join('; ')}`);
  }

  const normalized = stringifyYaml(plan);
  const planPath = getItemPlanPath(itemId);

  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, normalized, 'utf-8');

  return { plan, content: normalized };
}

export async function validatePlan(plan: Plan, itemConfig?: ItemConfig | null): Promise<string[]> {
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

  // Build valid repo names and roles from config
  const validRepoNames = itemConfig
    ? new Set(itemConfig.repositories.map(r => r.name))
    : null;
  const validRoles = itemConfig
    ? new Set([...itemConfig.repositories.map(r => r.role), 'review'])
    : null;

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

    if (!task.agent) {
      errors.push(`Task ${task.id || 'unknown'} missing agent field`);
    } else if (validRoles && !validRoles.has(task.agent)) {
      errors.push(`Task ${task.id || 'unknown'} has invalid agent: ${task.agent}. Valid: ${[...validRoles].join(', ')}`);
    }

    if (!task.repository) {
      errors.push(`Task ${task.id || 'unknown'}: repository field missing`);
    } else if (validRepoNames && !validRepoNames.has(task.repository)) {
      errors.push(`Task ${task.id || 'unknown'}: unknown repository "${task.repository}". Valid: ${[...validRepoNames].join(', ')}`);
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
