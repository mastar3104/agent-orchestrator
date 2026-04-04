import { describe, expect, it } from 'vitest';
import { composeRepositoryRolePrompt } from '../repository-role-prompts';

describe('composeRepositoryRolePrompt', () => {
  it('prepends fallback reviewer instructions before perspective-specific instructions', () => {
    const prompt = composeRepositoryRolePrompt(
      'Base prompt',
      {
        reviewer: 'Common reviewer instructions',
        securityReviewer: 'Focus on authorization and secret handling',
      },
      'securityReviewer',
      'reviewer'
    );

    expect(prompt).toContain('## Repository-Specific Instructions');
    expect(prompt).toContain('Common reviewer instructions');
    expect(prompt).toContain('Focus on authorization and secret handling');
    expect(prompt.indexOf('Common reviewer instructions')).toBeLessThan(
      prompt.indexOf('Focus on authorization and secret handling')
    );
    expect(prompt.endsWith('Base prompt')).toBe(true);
  });

  it('falls back to the shared reviewer prompt when no perspective-specific prompt exists', () => {
    const prompt = composeRepositoryRolePrompt(
      'Base prompt',
      {
        reviewer: 'Common reviewer instructions',
      },
      'testingReviewer',
      'reviewer'
    );

    expect(prompt).toContain('Common reviewer instructions');
    expect(prompt).not.toContain('undefined');
    expect(prompt.endsWith('Base prompt')).toBe(true);
  });
});
