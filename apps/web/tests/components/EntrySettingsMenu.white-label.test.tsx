// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EntrySettingsMenu } from '../../src/components/EntrySettingsMenu';
import { I18nProvider } from '../../src/i18n';
import type { AppConfig } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(['en', 'zh-CN', 'zh-TW'] as const)('keeps language and settings without upstream promotion in %s', (locale) => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const openSettings = vi.fn();
  const { container } = render(
    <I18nProvider initial={locale}>
      <EntrySettingsMenu config={{} as AppConfig} onOpenSettings={openSettings} />
    </I18nProvider>,
  );

  fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));
  expect(screen.getByTestId('entry-settings-menu')).toBeTruthy();
  expect(container.querySelectorAll('a')).toHaveLength(0);
  expect(fetch.mock.calls.some(([url]) => /community|social-share/.test(String(url)))).toBe(false);
  fireEvent.click(screen.getByTestId('entry-settings-open-details'));
  expect(openSettings).toHaveBeenCalledOnce();
});
