export const DESIGN_SYSTEM_WORKSPACE_PROMPT_PREFIX =
  'Create this project as a complete NexusDesign design system workspace.';

// Persisted messages and pending prompts may still contain the original brand.
const LEGACY_DESIGN_SYSTEM_WORKSPACE_PROMPT_PREFIX =
  'Create this project as a complete OpenDesign design system workspace.';

export function isDesignSystemWorkspacePrompt(content: string): boolean {
  const prompt = content.trimStart();
  return prompt.startsWith(DESIGN_SYSTEM_WORKSPACE_PROMPT_PREFIX)
    || prompt.startsWith(LEGACY_DESIGN_SYSTEM_WORKSPACE_PROMPT_PREFIX);
}
