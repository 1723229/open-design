import { describe, expect, it } from 'vitest';

import {
  DESIGN_SYSTEM_WORKSPACE_PROMPT_PREFIX,
  isDesignSystemWorkspacePrompt,
} from '../src/design-system-auto-prompt';

describe('isDesignSystemWorkspacePrompt', () => {
  it('uses the current brand for new prompts', () => {
    expect(DESIGN_SYSTEM_WORKSPACE_PROMPT_PREFIX).toBe(
      'Create this project as a complete NexusDesign design system workspace.',
    );
  });

  describe.each([
    DESIGN_SYSTEM_WORKSPACE_PROMPT_PREFIX,
    'Create this project as a complete OpenDesign design system workspace.',
  ])('prefix: %s', (prefix) => {
    it('detects the sentinel prefix at the very start of the content', () => {
      expect(isDesignSystemWorkspacePrompt(`${prefix} Build a teal palette.`)).toBe(true);
    });

    it('still detects the prefix when the content has leading whitespace or newlines', () => {
      expect(isDesignSystemWorkspacePrompt(`\n  ${prefix} extra detail`)).toBe(true);
    });

    it('rejects content that mentions the sentinel mid-string', () => {
      expect(isDesignSystemWorkspacePrompt(`Hello! ${prefix}`)).toBe(false);
    });
  });

  it('rejects empty and unrelated prompts', () => {
    expect(isDesignSystemWorkspacePrompt('')).toBe(false);
    expect(isDesignSystemWorkspacePrompt('Design me a logo.')).toBe(false);
  });
});
