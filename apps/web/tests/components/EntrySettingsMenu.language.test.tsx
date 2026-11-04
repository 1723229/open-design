// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntrySettingsMenu } from '../../src/components/EntrySettingsMenu';
import { I18nProvider, type Locale } from '../../src/i18n';
import type { AppConfig } from '../../src/types';

const { track } = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track }) };
});

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'daemon',
    agentId: null,
    agentModels: {},
    apiProtocol: 'anthropic',
    apiProtocolConfigs: {},
    apiKey: '',
    baseUrl: '',
    model: '',
    theme: 'system',
    ...overrides,
  } as AppConfig;
}

function renderMenu(locale: Locale = 'en') {
  return render(
    <I18nProvider initial={locale}>
      <EntrySettingsMenu
        config={baseConfig()}
        onOpenSettings={vi.fn()}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  track.mockClear();
  globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('EntrySettingsMenu fixed-language distribution', () => {
  it.each(['en', 'zh-CN'] as const)('hides language choices and retains settings in %s', (locale) => {
    const { container } = renderMenu(locale);
    fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
    expect(container.querySelector('.entry-settings-menu__select')).toBeNull();
    expect(screen.getByTestId('entry-settings-open-details')).toBeTruthy();
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });
});
