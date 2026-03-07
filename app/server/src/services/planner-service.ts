import { existsSync } from 'fs';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { dirname, join } from 'path';
import type { ItemConfig, Plan, PlanFeedbackItem, PlanTask } from '@agent-orch/shared';
import { getAgentsByItem, executeAgent } from './agent-service';
import { getItemConfig } from './item-service';
import {
  archiveCurrentTaskStates,
  createArchiveTag,
  regenerateTaskStatesForPlan,
} from './task-state-service';
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

type LegacyPlanTask = PlanTask & { agent?: string };
type LegacyPlan = Omit<Plan, 'tasks'> & { tasks: LegacyPlanTask[] };

function normalizeTask(task: LegacyPlanTask): PlanTask {
  const { agent: _agent, ...rest } = task;
  return {
    id: rest.id,
    title: rest.title,
    description: rest.description,
    repository: rest.repository,
    dependencies: rest.dependencies,
    files: rest.files,
  };
}

export function normalizePlan(plan: LegacyPlan): Plan {
  return {
    ...plan,
    tasks: Array.isArray(plan.tasks) ? plan.tasks.map(normalizeTask) : [],
  };
}

async function emitPlanCreated(itemId: string): Promise<void> {
  const planPath = getItemPlanPath(itemId);
  const event = createPlanCreatedEvent(itemId, planPath);
  await appendJsonl(getItemEventsPath(itemId), event);
  eventBus.emit('event', { itemId, event });
}

async function persistCurrentPlan(
  itemId: string,
  plan: Plan,
  itemConfig?: ItemConfig | null
): Promise<{ plan: Plan; content: string }> {
  const normalizedPlan = normalizePlan(plan as LegacyPlan);
  const errors = await validatePlan(normalizedPlan, itemConfig);
  if (errors.length > 0) {
    throw new Error(`Plan validation errors: ${errors.join('; ')}`);
  }

  const normalizedContent = stringifyYaml(normalizedPlan);
  const planPath = getItemPlanPath(itemId);
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, normalizedContent, 'utf-8');
  await regenerateTaskStatesForPlan(itemId, normalizedPlan);
  await emitPlanCreated(itemId);

  return { plan: normalizedPlan, content: normalizedContent };
}

async function loadGeneratedPlan(itemId: string): Promise<Plan> {
  const planPath = getItemPlanPath(itemId);
  if (!existsSync(planPath)) {
    throw new Error('Planner completed but plan.yaml was not created');
  }

  const content = await readFile(planPath, 'utf-8');
  return normalizePlan(parseYaml<LegacyPlan>(content));
}

export async function archiveCurrentPlan(
  itemId: string,
  archiveTag: string = createArchiveTag()
): Promise<string[]> {
  const archivedPaths: string[] = [];
  const planPath = getItemPlanPath(itemId);
  if (!existsSync(planPath)) {
    return archivedPaths;
  }

  const archiveFilename = `plan_${archiveTag}.yaml`;
  const archivePath = join(dirname(planPath), archiveFilename);
  await rename(planPath, archivePath);
  archivedPaths.push(archivePath);
  return archivedPaths;
}

export async function archiveCurrentExecutionArtifacts(
  itemId: string,
  archiveTag: string = createArchiveTag()
): Promise<{ archiveTag: string; archivedPlanPaths: string[]; archivedTaskStatePaths: string[] }> {
  const archivedPlanPaths = await archiveCurrentPlan(itemId, archiveTag);
  const archivedTaskStatePaths = await archiveCurrentTaskStates(itemId, archiveTag);
  return {
    archiveTag,
    archivedPlanPaths,
    archivedTaskStatePaths,
  };
}

export async function finalizeGeneratedPlan(
  itemId: string,
  itemConfig: ItemConfig,
  options?: { allowEmptyTasks?: boolean }
): Promise<void> {
  const plan = await loadGeneratedPlan(itemId);
  if (!options?.allowEmptyTasks && plan.tasks.length === 0) {
    throw new Error('plan.yaml has no tasks');
  }
  await persistCurrentPlan(itemId, plan, itemConfig);
}

export async function startPlanner(itemId: string): Promise<void> {
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

  await archiveCurrentExecutionArtifacts(itemId);
  await executeAgent<PlannerResponse>({
    itemId,
    role: 'planner',
    prompt,
    workingDir: workspaceRoot,
    allowedTools: role.allowedTools,
    jsonSchema: role.jsonSchema,
  });

  await finalizeGeneratedPlan(itemId, config);
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

## Task Rules

Use the \`repository\` field to specify which repository each task belongs to.
Do not include review tasks or any \`agent\` field in plan.yaml.`;
}

export async function getPlan(itemId: string): Promise<Plan | null> {
  const plan = await readYamlSafe<LegacyPlan>(getItemPlanPath(itemId));
  return plan ? normalizePlan(plan) : null;
}

export async function getPlanContent(itemId: string): Promise<string | null> {
  const planPath = getItemPlanPath(itemId);
  if (!existsSync(planPath)) {
    return null;
  }

  const rawContent = await readFile(planPath, 'utf-8');
  try {
    return stringifyYaml(normalizePlan(parseYaml<LegacyPlan>(rawContent)));
  } catch {
    return rawContent;
  }
}

export async function updatePlanContent(
  itemId: string,
  content: string
): Promise<{ plan: Plan; content: string }> {
  let parsedPlan: LegacyPlan;
  try {
    parsedPlan = parseYaml<LegacyPlan>(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid YAML';
    throw new Error(`Invalid YAML: ${message}`);
  }

  const normalizedPlan = normalizePlan(parsedPlan);
  const config = await getItemConfig(itemId);
  const errors = await validatePlan(normalizedPlan, config);
  if (normalizedPlan.itemId && normalizedPlan.itemId !== itemId) {
    errors.push(`itemId does not match (${normalizedPlan.itemId} !== ${itemId})`);
  }

  if (errors.length > 0) {
    throw new Error(`Plan validation failed: ${errors.join('; ')}`);
  }

  await archiveCurrentExecutionArtifacts(itemId);
  return persistCurrentPlan(itemId, normalizedPlan, config);
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

    if (!task.description) {
      errors.push(`Task ${task.id || 'unknown'} missing description`);
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

export function validatePlanFeedback(
  feedbacks: PlanFeedbackItem[],
  plan: Plan
): string[] {
  const errors: string[] = [];

  if (feedbacks.length === 0) {
    errors.push('feedbacks must not be empty');
    return errors;
  }

  const seenTaskIds = new Set<string>();
  const validTaskIds = new Set(plan.tasks.map(t => t.id));

  for (const fb of feedbacks) {
    const taskId = fb.taskId.trim();
    const feedback = fb.feedback.trim();

    if (!taskId) {
      errors.push('taskId must not be empty');
    }
    if (!feedback) {
      errors.push('feedback must not be empty');
    }

    if (taskId && seenTaskIds.has(taskId)) {
      errors.push(`Duplicate taskId: ${taskId}`);
    }
    seenTaskIds.add(taskId);

    if (taskId && !validTaskIds.has(taskId)) {
      errors.push(`taskId not found in plan: ${taskId}`);
    }
  }

  return errors;
}

export function formatFeedbacks(
  feedbacks: PlanFeedbackItem[],
  currentPlanContent: string
): string {
  const feedbackLines = feedbacks
    .map(fb => `- **${fb.taskId.trim()}**: "${fb.feedback.trim()}"`)
    .join('\n');

  return `## User Feedback on Current Plan

Revise plan.yaml to address the following feedback.
Preserve tasks not mentioned in the feedback.

### Current plan.yaml
\`\`\`yaml
${currentPlanContent}
\`\`\`

### Feedback
${feedbackLines}`;
}

export async function planFeedback(
  itemId: string,
  feedbacks: PlanFeedbackItem[]
): Promise<void> {
  const config = await getItemConfig(itemId);
  if (!config) {
    throw new Error(`Item ${itemId} not found`);
  }

  const planPath = getItemPlanPath(itemId);
  if (!existsSync(planPath)) {
    throw new Error('No plan exists yet');
  }

  const currentPlanContent = await readFile(planPath, 'utf-8');
  const role = getRole('planner');
  const context = buildPlannerContext(config);
  const feedbackSection = formatFeedbacks(feedbacks, currentPlanContent);
  const prompt = `${role.promptTemplate}\n\n${context}\n\n${feedbackSection}`;
  const workspaceRoot = getWorkspaceRoot(itemId);

  await archiveCurrentExecutionArtifacts(itemId);
  await executeAgent<PlannerResponse>({
    itemId,
    role: 'planner',
    prompt,
    workingDir: workspaceRoot,
    allowedTools: role.allowedTools,
    jsonSchema: role.jsonSchema,
  });

  await finalizeGeneratedPlan(itemId, config);
}
