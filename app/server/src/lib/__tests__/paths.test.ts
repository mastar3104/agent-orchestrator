import { describe, it, expect } from 'vitest';
import { getReviewResultFilePath } from '../paths';

describe('getReviewResultFilePath', () => {
  it('returns result-{perspective}.json when perspective is given', () => {
    const p = getReviewResultFilePath('ITEM-1', 'repo', 'task-1', 1, 'security');
    expect(p).toMatch(/review-round-1\/result-security\.json$/);
  });

  it('returns result.json when perspective is omitted', () => {
    const p = getReviewResultFilePath('ITEM-1', 'repo', 'task-1', 1);
    expect(p).toMatch(/review-round-1\/result\.json$/);
  });

  it('includes itemId, repoName, taskId in path', () => {
    const p = getReviewResultFilePath('ITEM-42', 'my-repo', 'task-7', 3, 'architecture');
    expect(p).toContain('ITEM-42');
    expect(p).toContain('my-repo');
    expect(p).toContain('task-7');
    expect(p).toContain('review-round-3');
    expect(p).toMatch(/result-architecture\.json$/);
  });

  it('handles all valid perspectives', () => {
    const perspectives = ['architecture', 'security', 'testing', 'requirements'] as const;
    for (const perspective of perspectives) {
      const p = getReviewResultFilePath('ITEM-1', 'repo', 'task-1', 1, perspective);
      expect(p).toMatch(new RegExp(`result-${perspective}\\.json$`));
    }
  });
});
