import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type {
  ItemConfig,
  ItemEvent,
  Plan,
  TestPlan,
  TestPlanApprovalState,
  TestPlanFeedbackItem,
  TestPlanScenario,
  VerificationPolicy,
} from '@agent-orch/shared';
import { getVerificationPolicyRank } from '@agent-orch/shared';
import { getItemConfig } from './item-service';
import { getAgentsByItem, executeAgent } from './agent-service';
import { appendJsonl, readJsonl } from '../lib/jsonl';
import {
  getItemEventsPath,
  getItemPlanPath,
  getItemTestPlanPath,
  getRepoWorkspaceDir,
  getWorkspaceRoot,
} from '../lib/paths';
import { eventBus } from './event-bus';
import { parseYaml, readYamlSafe, stringifyYaml } from '../lib/yaml';
import {
  createTestPlanApprovedEvent,
  createTestPlanCreatedEvent,
} from '../lib/events';
import { getRole } from '../lib/role-loader';
import { composeWorkspaceRolePrompts } from '../lib/repository-role-prompts';
import { createArchiveTag, createPlanFingerprint } from './task-state-service';
import {
  normalizePlanVerification,
  normalizePlanVerificationPolicy,
  normalizePlanVerificationRationale,
  normalizeTestPlanVerification,
  shouldAutoApproveTestPlan,
} from '../lib/verification-policy';
const TEST_PLANNER_SCHEMA_FALLBACK_MODE = 'result_or_empty' as const;

function normalizeScenario(scenario: TestPlanScenario): TestPlanScenario {
  return {
    id: scenario.id,
    kind: scenario.kind,
    title: scenario.title,
    repositories: Array.isArray(scenario.repositories) ? [...scenario.repositories] : [],
    given: scenario.given,
    when: scenario.when,
    then: scenario.then,
  };
}

function normalizeTestPlan(testPlan: TestPlan, currentPlan?: Plan | null): TestPlan {
  const scenarios = Array.isArray(testPlan.scenarios)
    ? testPlan.scenarios.map(normalizeScenario)
    : [];
  const verification = currentPlan
    ? normalizeTestPlanVerification({ ...testPlan, scenarios }, currentPlan)
    : {
        verificationPolicy: normalizePlanVerificationPolicy(
          testPlan.verificationPolicy,
          scenarios.length === 0 ? 0 : 1
        ),
        verificationRationale: normalizePlanVerificationRationale(
          testPlan.verificationRationale,
          normalizePlanVerificationPolicy(testPlan.verificationPolicy, scenarios.length === 0 ? 0 : 1),
          scenarios.length === 0 ? 0 : 1
        ),
      };

  return {
    ...testPlan,
    verificationPolicy: verification.verificationPolicy,
    verificationRationale: verification.verificationRationale,
    scenarios,
  };
}

export function createTestPlanFingerprint(testPlan: TestPlan): string {
  return createHash('sha256').update(stringifyYaml(normalizeTestPlan(testPlan))).digest('hex');
}

function getGeneratedTestPlanWorkingDir(itemId: string): string {
  return join(getWorkspaceRoot(itemId), '.test-planner');
}

function getGeneratedTestPlanSourcePath(itemId: string): string {
  return join(getGeneratedTestPlanWorkingDir(itemId), 'test-plan.yaml');
}

async function readCurrentPlan(itemId: string): Promise<Plan | null> {
  const plan = await readYamlSafe<Plan>(getItemPlanPath(itemId));
  return plan
    ? {
        ...plan,
        ...normalizePlanVerification(plan),
      }
    : null;
}

async function emitTestPlanCreated(
  itemId: string,
  planFingerprint: string,
  testPlanFingerprint: string
): Promise<void> {
  const event = createTestPlanCreatedEvent(
    itemId,
    getItemTestPlanPath(itemId),
    planFingerprint,
    testPlanFingerprint
  );
  await appendJsonl(getItemEventsPath(itemId), event);
  eventBus.emit('event', { itemId, event });
}

async function emitTestPlanApproved(
  itemId: string,
  planFingerprint: string,
  testPlanFingerprint: string,
  approvedBy: 'user' | 'auto'
): Promise<void> {
  const event = createTestPlanApprovedEvent(
    itemId,
    planFingerprint,
    testPlanFingerprint,
    approvedBy
  );
  await appendJsonl(getItemEventsPath(itemId), event);
  eventBus.emit('event', { itemId, event });
}

export async function archiveCurrentTestPlan(
  itemId: string,
  archiveTag: string = createArchiveTag()
): Promise<string[]> {
  const testPlanPath = getItemTestPlanPath(itemId);
  if (!existsSync(testPlanPath)) {
    return [];
  }

  const archivePath = join(dirname(testPlanPath), `test-plan_${archiveTag}.yaml`);
  await rename(testPlanPath, archivePath);
  return [archivePath];
}

async function loadGeneratedTestPlan(sourcePath: string): Promise<TestPlan> {
  if (!existsSync(sourcePath)) {
    throw new Error(`Test planner completed but test-plan.yaml was not created: ${sourcePath}`);
  }

  const content = await readFile(sourcePath, 'utf-8');
  return normalizeTestPlan(parseYaml<TestPlan>(content));
}

export function resolveVerificationPolicy(
  currentPlan?: Plan | null,
  currentTestPlan?: TestPlan | null
): {
  planPolicy: VerificationPolicy;
  resolvedPolicy: VerificationPolicy;
  planRationale: string;
  resolvedRationale: string;
  promotedByTestPlan: boolean;
} | null {
  if (!currentPlan) {
    return null;
  }

  const normalizedPlan = {
    ...currentPlan,
    ...normalizePlanVerification(currentPlan),
  };
  const normalizedTestPlan = currentTestPlan
    ? normalizeTestPlan(currentTestPlan, normalizedPlan)
    : null;
  const useTestPlan = Boolean(
    normalizedTestPlan &&
    normalizedTestPlan.planFingerprint === createPlanFingerprint(normalizedPlan)
  );
  const resolvedPolicy = useTestPlan
    ? normalizedTestPlan!.verificationPolicy
    : normalizedPlan.verificationPolicy;
  const resolvedRationale = useTestPlan
    ? normalizedTestPlan!.verificationRationale
    : normalizedPlan.verificationRationale;

  return {
    planPolicy: normalizedPlan.verificationPolicy,
    resolvedPolicy,
    planRationale: normalizedPlan.verificationRationale,
    resolvedRationale,
    promotedByTestPlan:
      getVerificationPolicyRank(resolvedPolicy) >
      getVerificationPolicyRank(normalizedPlan.verificationPolicy),
  };
}

export async function validateTestPlan(
  testPlan: TestPlan,
  itemConfig?: ItemConfig | null,
  currentPlan?: Plan | null
): Promise<string[]> {
  const errors: string[] = [];

  if (!testPlan.version) {
    errors.push('Missing version field');
  }

  if (!testPlan.itemId) {
    errors.push('Missing itemId field');
  }

  if (!testPlan.summary) {
    errors.push('Missing summary field');
  }

  if (!testPlan.verificationPolicy) {
    errors.push('Missing verificationPolicy field');
  }

  if (!testPlan.verificationRationale) {
    errors.push('Missing verificationRationale field');
  }

  if (!Array.isArray(testPlan.scenarios)) {
    errors.push('Missing or invalid scenarios array');
    return errors;
  }

  if (currentPlan) {
    const expectedPlanFingerprint = createPlanFingerprint(currentPlan);
    if (testPlan.planFingerprint !== expectedPlanFingerprint) {
      errors.push(
        `planFingerprint does not match current plan (${testPlan.planFingerprint} !== ${expectedPlanFingerprint})`
      );
    }
  }

  const validRepoNames = itemConfig
    ? new Set(itemConfig.repositories.map((repository) => repository.name))
    : null;
  const scenarioIds = new Set<string>();
  let bddScenarioCount = 0;
  let regressionScenarioCount = 0;

  for (const scenario of testPlan.scenarios) {
    if (!scenario.id) {
      errors.push('Scenario missing id field');
    } else if (scenarioIds.has(scenario.id)) {
      errors.push(`Duplicate scenario id: ${scenario.id}`);
    } else {
      scenarioIds.add(scenario.id);
    }

    if (!scenario.title) {
      errors.push(`Scenario ${scenario.id || 'unknown'} missing title`);
    }
    if (scenario.kind !== 'bdd' && scenario.kind !== 'regression') {
      errors.push(`Scenario ${scenario.id || 'unknown'} has invalid kind`);
    } else if (scenario.kind === 'bdd') {
      bddScenarioCount += 1;
    } else {
      regressionScenarioCount += 1;
    }
    if (!Array.isArray(scenario.repositories) || scenario.repositories.length === 0) {
      errors.push(`Scenario ${scenario.id || 'unknown'} must include at least one repository`);
    } else if (validRepoNames) {
      for (const repository of scenario.repositories) {
        if (!validRepoNames.has(repository)) {
          errors.push(
            `Scenario ${scenario.id || 'unknown'}: unknown repository "${repository}". Valid: ${[
              ...validRepoNames,
            ].join(', ')}`
          );
        }
      }
    }
    if (!scenario.given) {
      errors.push(`Scenario ${scenario.id || 'unknown'} missing given`);
    }
    if (!scenario.when) {
      errors.push(`Scenario ${scenario.id || 'unknown'} missing when`);
    }
    if (!scenario.then) {
      errors.push(`Scenario ${scenario.id || 'unknown'} missing then`);
    }
  }

  const planVerification = currentPlan
    ? resolveVerificationPolicy(currentPlan, testPlan)
    : null;
  const resolvedPolicy = planVerification?.resolvedPolicy ?? testPlan.verificationPolicy;
  if (resolvedPolicy === 'none' && testPlan.scenarios.length > 0) {
    errors.push('verificationPolicy=none requires scenarios to be empty');
  }
  if (resolvedPolicy === 'regression_only') {
    if (testPlan.scenarios.length === 0) {
      errors.push('verificationPolicy=regression_only requires at least one scenario');
    }
    if (bddScenarioCount > 0) {
      errors.push('verificationPolicy=regression_only allows regression scenarios only');
    }
  }
  if (resolvedPolicy === 'bdd_required' && bddScenarioCount === 0) {
    errors.push('verificationPolicy=bdd_required requires at least one bdd scenario');
  }
  if (
    currentPlan &&
    getVerificationPolicyRank(testPlan.verificationPolicy) <
      getVerificationPolicyRank(normalizePlanVerification(currentPlan).verificationPolicy)
  ) {
    errors.push('verificationPolicy cannot downgrade the current plan policy');
  }

  return errors;
}

async function persistCurrentTestPlan(
  itemId: string,
  testPlan: TestPlan,
  currentPlan: Plan,
  itemConfig?: ItemConfig | null,
  options?: { autoApprove?: boolean }
): Promise<{ testPlan: TestPlan; content: string; approval: TestPlanApprovalState }> {
  const normalizedPlan = {
    ...currentPlan,
    ...normalizePlanVerification(currentPlan),
  };
  const normalizedTestPlan = normalizeTestPlan({
    ...testPlan,
    itemId,
    planFingerprint: createPlanFingerprint(normalizedPlan),
    createdAt: testPlan.createdAt || new Date().toISOString(),
  }, normalizedPlan);
  const errors = await validateTestPlan(normalizedTestPlan, itemConfig, normalizedPlan);
  if (errors.length > 0) {
    throw new Error(`Test plan validation errors: ${errors.join('; ')}`);
  }

  const content = stringifyYaml(normalizedTestPlan);
  const testPlanPath = getItemTestPlanPath(itemId);
  await mkdir(dirname(testPlanPath), { recursive: true });
  await archiveCurrentTestPlan(itemId);
  await writeFile(testPlanPath, content, 'utf-8');

  const planFingerprint = normalizedTestPlan.planFingerprint;
  const testPlanFingerprint = createTestPlanFingerprint(normalizedTestPlan);
  await emitTestPlanCreated(itemId, planFingerprint, testPlanFingerprint);

  if (options?.autoApprove || shouldAutoApproveTestPlan(normalizedTestPlan.verificationPolicy)) {
    await emitTestPlanApproved(itemId, planFingerprint, testPlanFingerprint, 'auto');
  }

  const approval = await deriveTestPlanApproval(itemId, normalizedPlan, normalizedTestPlan);
  return { testPlan: normalizedTestPlan, content, approval };
}

function buildTestPlannerContext(itemConfig: ItemConfig, plan: Plan): string {
  const repoList = itemConfig.repositories
    .map((repository) => `- **${repository.name}** (type: ${repository.type})`)
    .join('\n');
  const planContent = stringifyYaml(plan);

  return `## Context

**Project Name:** ${itemConfig.name}
**Description:** ${itemConfig.description}

**Repositories:**
${repoList}

**Design Document:**
${itemConfig.designDoc || 'No design document provided.'}

**Item ID:** ${itemConfig.id}

## Current plan.yaml

\`\`\`yaml
${planContent}
\`\`\`

## Test Planning Rules

- Focus on externally observable behavior.
- Preserve coverage for existing behavior that could regress due to the planned changes.
- Always output top-level \`verificationPolicy\` and \`verificationRationale\`.
- You may keep the plan's \`verificationPolicy\` or promote it to a stricter level, but you must never downgrade it.
- Policy-specific constraints:
  - \`none\`: only for typo/copy/comment/non-behavioral changes; \`scenarios\` must be empty.
  - \`regression_only\`: use \`kind: regression\` only; include at least one scenario.
  - \`bdd_required\`: include at least one \`kind: bdd\` scenario; add regression scenarios as needed.
- Promote to \`bdd_required\` when the plan spans multiple repositories or when behavior depends on environment, DB/day data, or other conditions that automated tests alone do not sufficiently cover.`;
}

function buildTestPlannerPrompt(itemConfig: ItemConfig, plan: Plan): string {
  return composeWorkspaceRolePrompts(
    buildTestPlannerContext(itemConfig, plan),
    itemConfig.repositories,
    'testPlanner'
  );
}

function getTestPlannerAddDirs(itemId: string, itemConfig: ItemConfig): string[] {
  const addDirs: string[] = [];
  const seen = new Set<string>();

  for (const repository of itemConfig.repositories) {
    const repoDir = getRepoWorkspaceDir(itemId, repository.name);
    if (!existsSync(repoDir) || seen.has(repoDir)) {
      continue;
    }
    seen.add(repoDir);
    addDirs.push(repoDir);
  }

  return addDirs;
}

function buildEmptyTestPlan(itemId: string, currentPlan: Plan): TestPlan {
  return {
    version: '1.0',
    itemId,
    planFingerprint: createPlanFingerprint(currentPlan),
    summary: 'No executable test scenarios are required because the current plan has no implementation tasks.',
    verificationPolicy: 'none',
    verificationRationale: 'No implementation tasks are planned, so additional verification scenarios are not required.',
    scenarios: [],
    createdAt: new Date().toISOString(),
  };
}

async function runTestPlannerForCurrentPlan(
  itemId: string,
  itemConfig: ItemConfig,
  currentPlan: Plan
): Promise<void> {
  const normalizedPlan = {
    ...currentPlan,
    ...normalizePlanVerification(currentPlan),
  };
  if (currentPlan.tasks.length === 0) {
    await persistCurrentTestPlan(itemId, buildEmptyTestPlan(itemId, normalizedPlan), normalizedPlan, itemConfig, {
      autoApprove: true,
    });
    return;
  }

  const role = getRole('testPlanner');
  const prompt = buildTestPlannerPrompt(itemConfig, normalizedPlan);
  const workingDir = getGeneratedTestPlanWorkingDir(itemId);
  const sourcePath = getGeneratedTestPlanSourcePath(itemId);
  await mkdir(workingDir, { recursive: true });
  await rm(sourcePath, { force: true });

  await executeAgent<unknown>({
    itemId,
    role: 'test-planner',
    prompt,
    appendSystemPrompt: role.systemPrompt,
    addDirs: getTestPlannerAddDirs(itemId, itemConfig),
    workingDir,
    allowedTools: role.allowedTools,
    jsonSchema: role.jsonSchema,
    schemaFallbackMode: TEST_PLANNER_SCHEMA_FALLBACK_MODE,
  });

  const generatedTestPlan = await loadGeneratedTestPlan(sourcePath);
  await persistCurrentTestPlan(itemId, generatedTestPlan, normalizedPlan, itemConfig);
}

export async function startTestPlanner(itemId: string): Promise<void> {
  const agents = await getAgentsByItem(itemId);
  const existingTestPlanner = agents.find((agent) => agent.role === 'test-planner');
  if (existingTestPlanner) {
    if (existingTestPlanner.status !== 'error' && existingTestPlanner.status !== 'stopped' && existingTestPlanner.status !== 'completed') {
      console.log(
        `[${itemId}] Test planner already exists (status: ${existingTestPlanner.status}), skipping`
      );
      return;
    }
    console.log(
      `[${itemId}] Restarting test planner (previous status: ${existingTestPlanner.status})`
    );
  }

  const itemConfig = await getItemConfig(itemId);
  if (!itemConfig) {
    throw new Error(`Item ${itemId} not found`);
  }

  const currentPlan = await readCurrentPlan(itemId);
  if (!currentPlan) {
    throw new Error('No plan exists yet');
  }

  await runTestPlannerForCurrentPlan(itemId, itemConfig, currentPlan);
}

export async function synchronizeTestPlan(itemId: string, itemConfig: ItemConfig): Promise<void> {
  const currentPlan = await readCurrentPlan(itemId);
  if (!currentPlan) {
    throw new Error('No plan exists yet');
  }
  await runTestPlannerForCurrentPlan(itemId, itemConfig, currentPlan);
}

export async function getTestPlan(itemId: string, currentPlan?: Plan | null): Promise<TestPlan | null> {
  const testPlan = await readYamlSafe<TestPlan>(getItemTestPlanPath(itemId));
  return testPlan ? normalizeTestPlan(testPlan, currentPlan) : null;
}

export async function getTestPlanContent(itemId: string): Promise<string | null> {
  const testPlanPath = getItemTestPlanPath(itemId);
  if (!existsSync(testPlanPath)) {
    return null;
  }

  const rawContent = await readFile(testPlanPath, 'utf-8');
  try {
    const currentPlan = await readCurrentPlan(itemId);
    return stringifyYaml(normalizeTestPlan(parseYaml<TestPlan>(rawContent), currentPlan));
  } catch {
    return rawContent;
  }
}

export async function updateTestPlanContent(
  itemId: string,
  content: string
): Promise<{ testPlan: TestPlan; content: string; approval: TestPlanApprovalState }> {
  let parsedTestPlan: TestPlan;
  try {
    parsedTestPlan = parseYaml<TestPlan>(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid YAML';
    throw new Error(`Invalid YAML: ${message}`);
  }

  const itemConfig = await getItemConfig(itemId);
  if (!itemConfig) {
    throw new Error(`Item ${itemId} not found`);
  }
  const currentPlan = await readCurrentPlan(itemId);
  if (!currentPlan) {
    throw new Error('No plan exists yet');
  }

  if (parsedTestPlan.itemId && parsedTestPlan.itemId !== itemId) {
    throw new Error(`Test plan validation failed: itemId does not match (${parsedTestPlan.itemId} !== ${itemId})`);
  }

  return persistCurrentTestPlan(itemId, parsedTestPlan, currentPlan, itemConfig);
}

export function validateTestPlanFeedback(
  feedbacks: TestPlanFeedbackItem[],
  testPlan: TestPlan
): string[] {
  const errors: string[] = [];
  if (feedbacks.length === 0) {
    errors.push('feedbacks must not be empty');
    return errors;
  }

  const seenScenarioIds = new Set<string>();
  const validScenarioIds = new Set(testPlan.scenarios.map((scenario) => scenario.id));

  for (const feedback of feedbacks) {
    const scenarioId = feedback.scenarioId.trim();
    const text = feedback.feedback.trim();
    if (!scenarioId) {
      errors.push('scenarioId must not be empty');
    }
    if (!text) {
      errors.push('feedback must not be empty');
    }
    if (scenarioId && seenScenarioIds.has(scenarioId)) {
      errors.push(`Duplicate scenarioId: ${scenarioId}`);
    }
    seenScenarioIds.add(scenarioId);
    if (scenarioId && !validScenarioIds.has(scenarioId)) {
      errors.push(`scenarioId not found in test plan: ${scenarioId}`);
    }
  }

  return errors;
}

function formatTestPlanFeedbacks(
  feedbacks: TestPlanFeedbackItem[],
  currentTestPlanContent: string
): string {
  const feedbackLines = feedbacks
    .map((feedback) => `- **${feedback.scenarioId.trim()}**: "${feedback.feedback.trim()}"`)
    .join('\n');

  return `## User Feedback on Current Test Plan

Revise test-plan.yaml to address the following feedback.
Preserve scenarios not mentioned in the feedback.

### Current test-plan.yaml
\`\`\`yaml
${currentTestPlanContent}
\`\`\`

### Feedback
${feedbackLines}`;
}

export async function testPlanFeedback(
  itemId: string,
  feedbacks: TestPlanFeedbackItem[]
): Promise<void> {
  const itemConfig = await getItemConfig(itemId);
  if (!itemConfig) {
    throw new Error(`Item ${itemId} not found`);
  }
  const currentPlan = await readCurrentPlan(itemId);
  if (!currentPlan) {
    throw new Error('No plan exists yet');
  }
  const currentTestPlan = await getTestPlan(itemId, currentPlan);
  if (!currentTestPlan) {
    throw new Error('No test plan exists yet');
  }
  if (currentTestPlan.planFingerprint !== createPlanFingerprint(currentPlan)) {
    throw new Error('Current test plan is stale for the live plan');
  }

  const role = getRole('testPlanner');
  const prompt = `${buildTestPlannerPrompt(itemConfig, currentPlan)}\n\n${formatTestPlanFeedbacks(
    feedbacks,
    stringifyYaml(currentTestPlan)
  )}`;
  const workingDir = getGeneratedTestPlanWorkingDir(itemId);
  const sourcePath = getGeneratedTestPlanSourcePath(itemId);
  await mkdir(workingDir, { recursive: true });
  await rm(sourcePath, { force: true });

  await executeAgent<unknown>({
    itemId,
    role: 'test-planner',
    prompt,
    appendSystemPrompt: role.systemPrompt,
    addDirs: getTestPlannerAddDirs(itemId, itemConfig),
    workingDir,
    allowedTools: role.allowedTools,
    jsonSchema: role.jsonSchema,
    schemaFallbackMode: TEST_PLANNER_SCHEMA_FALLBACK_MODE,
  });

  const generatedTestPlan = await loadGeneratedTestPlan(sourcePath);
  await persistCurrentTestPlan(itemId, generatedTestPlan, currentPlan, itemConfig);
}

export async function deriveTestPlanApproval(
  itemId: string,
  currentPlanArg?: Plan | null,
  currentTestPlanArg?: TestPlan | null
): Promise<TestPlanApprovalState> {
  const currentPlan = currentPlanArg ?? await readCurrentPlan(itemId);
  if (!currentPlan) {
    return { status: 'missing' };
  }

  const planFingerprint = createPlanFingerprint(currentPlan);
  const currentTestPlan = currentTestPlanArg ?? await getTestPlan(itemId, currentPlan);
  if (!currentTestPlan) {
    return { status: 'missing', planFingerprint };
  }

  const testPlanFingerprint = createTestPlanFingerprint(currentTestPlan);
  if (currentTestPlan.planFingerprint !== planFingerprint) {
    return {
      status: 'stale',
      planFingerprint,
      testPlanFingerprint,
    };
  }

  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));
  const latestCreatedEvent = [...events]
    .reverse()
    .find((event): event is Extract<ItemEvent, { type: 'test_plan_created' }> =>
      event.type === 'test_plan_created' &&
      event.planFingerprint === planFingerprint &&
      event.testPlanFingerprint === testPlanFingerprint
    );
  const latestApprovedEvent = [...events]
    .reverse()
    .find((event): event is Extract<ItemEvent, { type: 'test_plan_approved' }> =>
      event.type === 'test_plan_approved' &&
      event.planFingerprint === planFingerprint &&
      event.testPlanFingerprint === testPlanFingerprint
    );

  if (
    latestApprovedEvent &&
    (!latestCreatedEvent || latestApprovedEvent.timestamp >= latestCreatedEvent.timestamp)
  ) {
    return {
      status: 'approved',
      planFingerprint,
      testPlanFingerprint,
      approvedAt: latestApprovedEvent.timestamp,
      approvedBy: latestApprovedEvent.approvedBy,
    };
  }

  return {
    status: 'pending',
    planFingerprint,
    testPlanFingerprint,
  };
}

export async function approveTestPlan(itemId: string): Promise<TestPlanApprovalState> {
  const currentPlan = await readCurrentPlan(itemId);
  if (!currentPlan) {
    throw new Error('No plan exists yet');
  }

  const currentTestPlan = await getTestPlan(itemId, currentPlan);
  if (!currentTestPlan) {
    throw new Error('No test plan exists yet');
  }

  const approval = await deriveTestPlanApproval(itemId, currentPlan, currentTestPlan);
  if (approval.status === 'missing') {
    throw new Error('No test plan exists yet');
  }
  if (approval.status === 'stale') {
    throw new Error('Current test plan is stale for the live plan');
  }
  if (approval.status === 'approved') {
    return approval;
  }

  await emitTestPlanApproved(
    itemId,
    approval.planFingerprint!,
    approval.testPlanFingerprint!,
    'user'
  );
  return deriveTestPlanApproval(itemId, currentPlan, currentTestPlan);
}

export async function ensureApprovedTestPlan(itemId: string): Promise<TestPlanApprovalState> {
  const approval = await deriveTestPlanApproval(itemId);
  if (approval.status !== 'approved') {
    throw new Error(
      `Test plan approval is required before starting workers (current status: ${approval.status})`
    );
  }
  return approval;
}
