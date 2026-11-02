// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { DEFAULT_CONFIG } from '../../src/state/config';

afterEach(cleanup);

it('removes the complete assistant identity row while retaining reply and continuation semantics', () => {
  const { rerender } = render(<I18nProvider initial="en"><AssistantMessage message={{ id: 'reply', role: 'assistant', content: 'Your design is ready.', createdAt: 1 }} streaming={false} showRole /></I18nProvider>);
  expect(screen.queryByTestId('assistant-role')).toBeNull();
  expect(screen.getByText('Your design is ready.')).toBeTruthy();
  expect(screen.getByTestId('assistant-message').getAttribute('data-continuation')).toBe('false');
  rerender(<I18nProvider initial="en"><AssistantMessage message={{ id: 'reply', role: 'assistant', content: 'Continued reply.', createdAt: 1 }} streaming={false} showRole={false} /></I18nProvider>);
  expect(screen.getByTestId('assistant-message').getAttribute('data-continuation')).toBe('true');
});

it.each(['page', 'modal'] as const)('hides Labs and MCP Server and normalizes their deep links in %s settings', (presentation) => {
  const props = { presentation, initial: DEFAULT_CONFIG, agents: [], daemonLive: false, appVersionInfo: null, onPersist: vi.fn(), onPersistComposioKey: vi.fn(), onClose: vi.fn(), onRefreshAgents: vi.fn() };
  const { rerender } = render(<I18nProvider initial="en"><SettingsDialog {...props} initialSection="labs" /></I18nProvider>);
  const sidebar = screen.getByRole('complementary', { name: 'Settings sections' });
  expect(within(sidebar).queryByText(/NexusDesign Labs/)).toBeNull();
  expect(within(sidebar).queryByText('NexusDesign MCP')).toBeNull();
  expect(screen.queryByTestId('settings-nav-execution')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
  rerender(<I18nProvider initial="en"><SettingsDialog {...props} initialSection="integrations" /></I18nProvider>);
  expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
});
