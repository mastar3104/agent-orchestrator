import type { ItemRepositoryConfig, RepoSummary } from '@agent-orch/shared';

export type SetupCommandStatus = 'no_setup' | 'pending' | 'running' | 'completed' | 'failed';

export const SETUP_STATUS_STYLES: Record<SetupCommandStatus, string> = {
  no_setup: 'bg-gray-700 text-gray-400',
  pending: 'bg-gray-600 text-gray-300',
  running: 'bg-amber-500/20 text-amber-200',
  completed: 'bg-emerald-500/20 text-emerald-200',
  failed: 'bg-red-500/20 text-red-200',
};

export const SETUP_STATUS_LABELS: Record<SetupCommandStatus, string> = {
  no_setup: 'No setup commands',
  pending: 'Setup pending',
  running: 'Setup running',
  completed: 'Setup completed',
  failed: 'Setup failed',
};

export const SETUP_STATUS_ICONS: Record<SetupCommandStatus, string> = {
  no_setup: '',
  pending: '',
  running: '\u27F3',
  completed: '\u2713',
  failed: '\u2715',
};

const POST_SETUP_PHASES = new Set([
  'engineer', 'hooks', 'review', 'completed_review', 'pr', 'review_receive',
]);

export function getRepoSetupStatus(
  repoConfig: Pick<ItemRepositoryConfig, 'type' | 'setup'>,
  repoSummary: Pick<RepoSummary, 'status' | 'activePhase'> | undefined,
  eventResult: boolean | undefined
): SetupCommandStatus {
  if (repoConfig.type !== 'remote' || !repoConfig.setup || repoConfig.setup.length === 0) {
    return 'no_setup';
  }
  if (eventResult === true) return 'completed';
  if (eventResult === false) return 'failed';
  if (!repoSummary) return 'pending';
  if (repoSummary.activePhase === 'setup') return 'running';
  if (repoSummary.activePhase === 'clone' || repoSummary.activePhase === 'workspace_setup') return 'pending';
  if (repoSummary.activePhase && POST_SETUP_PHASES.has(repoSummary.activePhase)) return 'completed';
  if (['ready', 'completed', 'review_receiving'].includes(repoSummary.status)) return 'completed';
  if (repoSummary.status === 'error') return 'failed';
  return 'pending';
}
