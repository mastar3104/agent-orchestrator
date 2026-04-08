import { describe, expect, it, vi } from 'vitest';
import type { ReviewFinding } from '@agent-orch/shared';
import {
  buildFeedbackPrompt,
  sortReviewFindings,
  isCompatibleReviewerRole,
  resolveReviewerSystemPrompt,
} from '../worker-service';
import { getRole } from '../../lib/role-loader';

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

  it('lists review result file paths in the feedback prompt', () => {
    const prompt = buildFeedbackPrompt(
      {} as any,
      { name: 'repo-a' } as any,
      [
        '/reviews/repo-a/T1/review-round-1/result-security.json',
        '/reviews/repo-a/T1/review-round-1/result-architecture.json',
      ],
      'diff --git a/file.ts b/file.ts',
      [{ id: 'T1', title: 'Task', description: '', repository: 'repo-a', files: [], dependencies: [] }]
    );

    expect(prompt).toContain('/reviews/repo-a/T1/review-round-1/result-security.json');
    expect(prompt).toContain('/reviews/repo-a/T1/review-round-1/result-architecture.json');
    expect(prompt).toContain('Review result files');
    expect(prompt).toContain('Read the review result files');
  });

  it('treats a reviewer role with Write but not Edit as compatible', () => {
    const reviewerRole = getRole('reviewer');
    expect(reviewerRole.allowedTools).toContain('Write');
    expect(reviewerRole.allowedTools).not.toContain('Edit');
    expect(isCompatibleReviewerRole(reviewerRole)).toBe(true);
  });

  it('rejects a role that includes Edit', () => {
    const fakeRole = { allowedTools: ['Read', 'Edit'], systemPrompt: '', jsonSchema: undefined };
    expect(isCompatibleReviewerRole(fakeRole as any)).toBe(false);
  });

  it('accepts a role with only read tools', () => {
    const fakeRole = { allowedTools: ['Read', 'Glob', 'Grep'], systemPrompt: '', jsonSchema: undefined };
    expect(isCompatibleReviewerRole(fakeRole as any)).toBe(true);
  });

  it('shows fallback message when no review result file paths are provided', () => {
    const prompt = buildFeedbackPrompt(
      {} as any,
      { name: 'repo-a' } as any,
      [],
      'diff --git a/file.ts b/file.ts',
      [{ id: 'T1', title: 'Task', description: '', repository: 'repo-a', files: [], dependencies: [] }]
    );

    expect(prompt).toContain('No review result files available');
    expect(prompt).toContain('git add -A -- <paths>');
    expect(prompt).toContain('Return {"status": "success"}');
  });
});

describe('resolveReviewerSystemPrompt', () => {
  it('resolves {{reviewResultFilePath}} placeholder in reviewer system prompt', () => {
    const role = getRole('reviewer');
    expect(role.systemPrompt).toContain('{{reviewResultFilePath}}');
    const resolved = resolveReviewerSystemPrompt(role.systemPrompt, 'ITEM-1', 'repo', 'task-1', 1);
    expect(resolved).not.toContain('{{reviewResultFilePath}}');
    expect(resolved).toContain('result.json');
  });

  it('resolves placeholder with perspective', () => {
    const role = getRole('securityReviewer');
    const resolved = resolveReviewerSystemPrompt(
      role.systemPrompt,
      'ITEM-1',
      'repo',
      'task-1',
      1,
      'security'
    );
    expect(resolved).not.toContain('{{reviewResultFilePath}}');
    expect(resolved).toContain('result-security.json');
  });

  it('resolves placeholder for all perspective reviewer roles', () => {
    const perspectives = [
      { roleName: 'architectureReviewer', perspective: 'architecture' },
      { roleName: 'securityReviewer', perspective: 'security' },
      { roleName: 'testingReviewer', perspective: 'testing' },
      { roleName: 'requirementsReviewer', perspective: 'requirements' },
    ] as const;
    for (const { roleName, perspective } of perspectives) {
      const role = getRole(roleName);
      expect(role.systemPrompt).toContain('{{reviewResultFilePath}}');
      const resolved = resolveReviewerSystemPrompt(
        role.systemPrompt,
        'ITEM-1',
        'repo',
        'task-1',
        2,
        perspective
      );
      expect(resolved).not.toContain('{{reviewResultFilePath}}');
      expect(resolved).toContain(`result-${perspective}.json`);
    }
  });

  it('warns when placeholder is not found in system prompt', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveReviewerSystemPrompt(
      'No placeholder here',
      'ITEM-1',
      'repo',
      'task-1',
      1
    );
    expect(result).toBe('No placeholder here');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('placeholder {{reviewResultFilePath}} not found')
    );
    warnSpy.mockRestore();
  });
});
