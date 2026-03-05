import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { ItemConfig, Plan } from '@agent-orch/shared';
import { getAgentsByItem, executeAgent } from './agent-service';
import { getItemConfig } from './item-service';
import { readYamlSafe, parseYaml, stringifyYaml } from '../lib/yaml';
import { appendJsonl } from '../lib/jsonl';
import { createPlanCreatedEvent } from '../lib/events';
import {
  getItemPlanPath,
  getItemEventsPath,
  getWorkspaceRoot,
} from '../lib/paths';
import { eventBus } from './event-bus';
import { type PlannerResponse } from '../lib/claude-schemas';
import { getRole } from '../lib/role-loader';

export async function startPlanner(itemId: string): Promise<void> {
  // Check for existing planner (allow restart from error/stopped)
  const agents = await getAgentsByItem(itemId);
  const existingPlanner = agents.find(a => a.role === 'planner');
  if (existingPlanner) {
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

  const role = getRole('planner');
  const context = buildPlannerContext(config);
  const prompt = `${role.promptTemplate}\n\n${context}`;
  const workspaceRoot = getWorkspaceRoot(itemId);
  const planPath = getItemPlanPath(itemId);

  // Execute planner agent — executeAgent handles event logging + process tracking
  await executeAgent<PlannerResponse>({
    itemId,
    role: 'planner',
    prompt,
    workingDir: workspaceRoot,
    allowedTools: role.allowedTools,
    jsonSchema: role.jsonSchema,
  });

  // Validate plan was created
  if (!existsSync(planPath)) {
    throw new Error('Planner completed but plan.yaml was not created');
  }

  const content = await readFile(planPath, 'utf-8');
  const plan = parseYaml<Plan>(content);
  if (!plan || !plan.tasks || plan.tasks.length === 0) {
    throw new Error('plan.yaml has no tasks');
  }

  const errors = await validatePlan(plan, config);
  if (errors.length > 0) {
    throw new Error(`Plan validation errors: ${errors.join('; ')}`);
  }

  // Emit plan_created event
  const event = createPlanCreatedEvent(itemId, planPath);
  await appendJsonl(getItemEventsPath(itemId), event);
  eventBus.emit('event', { itemId, event });
}

function buildPlannerContext(config: ItemConfig): string {
  const repoList = config.repositories
    .map(r => `- **${r.name}** (type: ${r.type})`)
    .join('\n');

  return `## Context

**Project Name:** ${config.name}
**Description:** ${config.description}

**Repositories:**
${repoList}

**Design Document:**
${config.designDoc || 'No design document provided.'}

**Item ID:** ${config.id}

## Task Agent Values

For development tasks, use \`agent: "engineer"\`.
For review tasks, use \`agent: "review"\`.
Use the \`repository\` field to specify which repository each task belongs to.`;
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

  const validRepoNames = itemConfig
    ? new Set(itemConfig.repositories.map(r => r.name))
    : null;
  const validAgents = new Set(['engineer', 'review']);

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
    } else if (!validAgents.has(task.agent)) {
      errors.push(`Task ${task.id || 'unknown'} has invalid agent: ${task.agent}. Valid: ${[...validAgents].join(', ')}`);
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
