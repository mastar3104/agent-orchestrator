import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '@agent-orch/shared';
import { buildFeedbackPrompt, sortReviewFindings } from '../worker-service';

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'major',
    file: 'file.ts',
    description: 'default finding',
    suggestedFix: '',
    targetAgent: 'repo-a',
    ...overrides,
  };
}

describe('worker-service helpers', () => {
  it('sorts findings by severity, perspective order, file, and line', () => {
    const findings: ReviewFinding[] = [
      makeFinding({ perspective: 'testing', file: 'z.ts', line: 8, severity: 'major' }),
      makeFinding({ perspective: 'security', file: 'b.ts', line: 5, severity: 'major' }),
      makeFinding({ perspective: 'architecture', file: 'a.ts', line: 4, severity: 'critical' }),
      makeFinding({ file: 'a.ts', line: 1, severity: 'major' }),
      makeFinding({ perspective: 'security', file: 'a.ts', line: 2, severity: 'major' }),
      makeFinding({ perspective: 'requirements', file: 'a.ts', line: 3, severity: 'minor' }),
    ];

    expect(sortReviewFindings(findings)).toEqual([
      makeFinding({ perspective: 'architecture', file: 'a.ts', line: 4, severity: 'critical' }),
      makeFinding({ perspective: 'security', file: 'a.ts', line: 2, severity: 'major' }),
      makeFinding({ perspective: 'security', file: 'b.ts', line: 5, severity: 'major' }),
      makeFinding({ perspective: 'testing', file: 'z.ts', line: 8, severity: 'major' }),
      makeFinding({ file: 'a.ts', line: 1, severity: 'major' }),
      makeFinding({ perspective: 'requirements', file: 'a.ts', line: 3, severity: 'minor' }),
    ]);
  });

  it('builds perspective-grouped feedback sections in the configured order', () => {
    const prompt = buildFeedbackPrompt(
      {} as any,
      { name: 'repo-a' } as any,
      [
        makeFinding({
          perspective: 'architecture',
          file: 'arch.ts',
          description: 'Split orchestration concerns.',
          severity: 'minor',
        }),
        makeFinding({
          perspective: 'testing',
          file: 'worker.test.ts',
          description: 'Add a regression test.',
          severity: 'major',
        }),
        makeFinding({
          perspective: 'security',
          file: 'auth.ts',
          description: 'Enforce authorization.',
          severity: 'critical',
        }),
        makeFinding({
          perspective: 'requirements',
          file: 'requirements.ts',
          description: 'Preserve acceptance criteria.',
          severity: 'major',
        }),
      ],
      'diff --git a/file.ts b/file.ts',
      [{ id: 'T1', title: 'Task', description: '', repository: 'repo-a', files: [], dependencies: [] }]
    );

    const securityIndex = prompt.indexOf('### Security');
    const requirementsIndex = prompt.indexOf('### Requirements');
    const architectureIndex = prompt.indexOf('### Architecture');
    const testingIndex = prompt.indexOf('### Testing');

    expect(securityIndex).toBeGreaterThan(-1);
    expect(requirementsIndex).toBeGreaterThan(securityIndex);
    expect(architectureIndex).toBeGreaterThan(requirementsIndex);
    expect(testingIndex).toBeGreaterThan(architectureIndex);
  });

  it('keeps legacy feedback flat when findings do not include perspectives', () => {
    const prompt = buildFeedbackPrompt(
      {} as any,
      { name: 'repo-a' } as any,
      [
        makeFinding({ file: 'b.ts', line: 3, description: 'Second issue', severity: 'minor' }),
        makeFinding({ file: 'a.ts', line: 1, description: 'First issue', severity: 'critical' }),
      ],
      'diff --git a/file.ts b/file.ts',
      [{ id: 'T1', title: 'Task', description: '', repository: 'repo-a', files: [], dependencies: [] }]
    );

    expect(prompt).not.toContain('### Security');
    expect(prompt).toContain('- [CRITICAL] a.ts:1: First issue');
    expect(prompt).toContain('- [MINOR] b.ts:3: Second issue');
  });
});
