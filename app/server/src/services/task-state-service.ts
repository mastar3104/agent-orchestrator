import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readdir, rename } from 'fs/promises';
import { join } from 'path';
import type { Plan, PlanTask, TaskExecutionStatus, TaskProgressPhase } from '@agent-orch/shared';
import {
  getRepoTaskStatePath,
  getTaskStateArchiveDir,
  getTaskStateDir,
} from '../lib/paths';
import { readYamlSafe, stringifyYaml, writeYaml } from '../lib/yaml';

export interface RepoTaskStateTask {
  id: string;
  title: string;
  dependencies: string[];
  status: TaskExecutionStatus;
  currentPhase?: TaskProgressPhase;
  attempts: number;
  phaseBase?: string;
  reviewRounds?: number;
  lastStartedAt?: string;
  completedAt?: string;
  lastError?: string;
  commitHash?: string;
  filesModified?: string[];
}

export interface RepoTaskStateFile {
  version: string;
  itemId: string;
  repository: string;
  planFingerprint: string;
  createdAt: string;
  updatedAt: string;
  tasks: RepoTaskStateTask[];
}

export function createArchiveTag(now: Date = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .replace(/\.\d{3}Z$/, `_${String(now.getMilliseconds()).padStart(3, '0')}`);
  const randomSuffix = randomBytes(3).toString('hex');
  return `${timestamp}_${randomSuffix}`;
}

export function createPlanFingerprint(plan: Plan): string {
  return createHash('sha256').update(stringifyYaml(plan)).digest('hex');
}

function buildTaskStateTask(task: PlanTask): RepoTaskStateTask {
  return {
    id: task.id,
    title: task.title,
    dependencies: [...(task.dependencies || [])],
    status: 'pending',
    attempts: 0,
  };
}

function buildRepoTaskState(
  itemId: string,
  repository: string,
  planFingerprint: string,
  tasks: PlanTask[],
  now: string
): RepoTaskStateFile {
  return {
    version: '1',
    itemId,
    repository,
    planFingerprint,
    createdAt: now,
    updatedAt: now,
    tasks: tasks.map(buildTaskStateTask),
  };
}

export async function readRepoTaskState(
  itemId: string,
  repoName: string
): Promise<RepoTaskStateFile | null> {
  return readYamlSafe<RepoTaskStateFile>(getRepoTaskStatePath(itemId, repoName));
}

export async function writeRepoTaskState(
  itemId: string,
  state: RepoTaskStateFile
): Promise<void> {
  await writeYaml(getRepoTaskStatePath(itemId, state.repository), state);
}

export async function regenerateTaskStatesForPlan(
  itemId: string,
  plan: Plan
): Promise<RepoTaskStateFile[]> {
  const planFingerprint = createPlanFingerprint(plan);
  const now = new Date().toISOString();
  const tasksByRepo = new Map<string, PlanTask[]>();

  for (const task of plan.tasks) {
    const repoTasks = tasksByRepo.get(task.repository) || [];
    repoTasks.push(task);
    tasksByRepo.set(task.repository, repoTasks);
  }

  const states: RepoTaskStateFile[] = [];
  for (const [repoName, repoTasks] of tasksByRepo) {
    const state = buildRepoTaskState(itemId, repoName, planFingerprint, repoTasks, now);
    await writeRepoTaskState(itemId, state);
    states.push(state);
  }

  return states;
}

export async function archiveCurrentTaskStates(
  itemId: string,
  archiveTag: string = createArchiveTag()
): Promise<string[]> {
  const taskStateDir = getTaskStateDir(itemId);
  if (!existsSync(taskStateDir)) {
    return [];
  }

  const archivedPaths: string[] = [];
  const files = await readdir(taskStateDir);
  const stateFiles = files.filter((file) => file.endsWith('.yaml'));
  const archiveDir = getTaskStateArchiveDir(itemId);
  await mkdir(archiveDir, { recursive: true });

  for (const file of stateFiles) {
    const fromPath = join(taskStateDir, file);
    const archivePath = join(archiveDir, `${file.replace(/\.yaml$/, '')}_${archiveTag}.yaml`);
    await rename(fromPath, archivePath);
    archivedPaths.push(archivePath);
  }

  return archivedPaths;
}

export async function ensureTaskStatesForPlan(
  itemId: string,
  plan: Plan
): Promise<RepoTaskStateFile[]> {
  const repos = [...new Set(plan.tasks.map((task) => task.repository))];
  const expectedFingerprint = createPlanFingerprint(plan);
  const states: RepoTaskStateFile[] = [];

  let requiresRegeneration = false;
  for (const repoName of repos) {
    const state = await readRepoTaskState(itemId, repoName);
    if (!state || state.planFingerprint !== expectedFingerprint) {
      requiresRegeneration = true;
      break;
    }
    states.push(state);
  }

  if (!requiresRegeneration) {
    return states;
  }

  if (existsSync(getTaskStateDir(itemId))) {
    await archiveCurrentTaskStates(itemId);
  }

  return regenerateTaskStatesForPlan(itemId, plan);
}
