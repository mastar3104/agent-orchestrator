import { describe, expect, it } from 'vitest';
import { getRepoSetupStatus } from '../setup-status';

describe('getRepoSetupStatus', () => {
  // Branch 1: local repo → no_setup
  it('returns no_setup for local repository', () => {
    expect(
      getRepoSetupStatus({ type: 'local', setup: ['npm install'] }, undefined, undefined)
    ).toBe('no_setup');
  });

  // Branch 2: remote repo without setup array → no_setup
  it('returns no_setup for remote repo without setup field', () => {
    expect(
      getRepoSetupStatus({ type: 'remote' }, undefined, undefined)
    ).toBe('no_setup');
  });

  // Branch 3: remote repo with empty setup array → no_setup
  it('returns no_setup for remote repo with empty setup array', () => {
    expect(
      getRepoSetupStatus({ type: 'remote', setup: [] }, undefined, undefined)
    ).toBe('no_setup');
  });

  // Branch 4: eventResult true → completed
  it('returns completed when eventResult is true', () => {
    expect(
      getRepoSetupStatus(
        { type: 'remote', setup: ['npm install'] },
        { status: 'running', activePhase: 'setup' },
        true
      )
    ).toBe('completed');
  });

  // Branch 5: eventResult false → failed
  it('returns failed when eventResult is false', () => {
    expect(
      getRepoSetupStatus(
        { type: 'remote', setup: ['npm install'] },
        { status: 'running', activePhase: 'setup' },
        false
      )
    ).toBe('failed');
  });

  // Branch 6: no repoSummary → pending
  it('returns pending when repoSummary is undefined', () => {
    expect(
      getRepoSetupStatus(
        { type: 'remote', setup: ['npm install'] },
        undefined,
        undefined
      )
    ).toBe('pending');
  });

  // Branch 7: activePhase === 'setup' → running
  it('returns running when activePhase is setup', () => {
    expect(
      getRepoSetupStatus(
        { type: 'remote', setup: ['npm install'] },
        { status: 'running', activePhase: 'setup' },
        undefined
      )
    ).toBe('running');
  });

  // Branch 8a: activePhase === 'clone' → pending
  it('returns pending when activePhase is clone', () => {
    expect(
      getRepoSetupStatus(
        { type: 'remote', setup: ['npm install'] },
        { status: 'running', activePhase: 'clone' },
        undefined
      )
    ).toBe('pending');
  });

  // Branch 8b: activePhase === 'workspace_setup' → pending
  it('returns pending when activePhase is workspace_setup', () => {
    expect(
      getRepoSetupStatus(
        { type: 'remote', setup: ['npm install'] },
        { status: 'running', activePhase: 'workspace_setup' },
        undefined
      )
    ).toBe('pending');
  });

  // Branch 9: post-setup phases → completed
  it.each([
    'engineer', 'hooks', 'review', 'completed_review', 'pr', 'review_receive',
  ] as const)('returns completed when activePhase is %s (post-setup)', (phase) => {
    expect(
      getRepoSetupStatus(
        { type: 'remote', setup: ['npm install'] },
        { status: 'running', activePhase: phase },
        undefined
      )
    ).toBe('completed');
  });

  // Branch 10: status-based completed
  it.each(['ready', 'completed', 'review_receiving'] as const)(
    'returns completed when status is %s',
    (status) => {
      expect(
        getRepoSetupStatus(
          { type: 'remote', setup: ['npm install'] },
          { status, activePhase: undefined },
          undefined
        )
      ).toBe('completed');
    }
  );

  // Branch 11: status === 'error' → failed
  it('returns failed when status is error', () => {
    expect(
      getRepoSetupStatus(
        { type: 'remote', setup: ['npm install'] },
        { status: 'error', activePhase: undefined },
        undefined
      )
    ).toBe('failed');
  });

  // Branch 12: default → pending
  it('returns pending as default for unmatched status/phase', () => {
    expect(
      getRepoSetupStatus(
        { type: 'remote', setup: ['npm install'] },
        { status: 'not_started', activePhase: undefined },
        undefined
      )
    ).toBe('pending');
  });

  // Priority: eventResult overrides repoSummary
  it('eventResult takes priority over repoSummary phase', () => {
    expect(
      getRepoSetupStatus(
        { type: 'remote', setup: ['npm install'] },
        { status: 'running', activePhase: 'engineer' },
        false
      )
    ).toBe('failed');
  });
});
