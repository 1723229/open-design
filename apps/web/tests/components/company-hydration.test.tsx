// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { CompanyProvider } from '../../src/company/CompanyProvider';
import { I18nProvider } from '../../src/i18n';

it('hydrates the login loading gate when the browser locale differs from the static shell', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  const container = document.createElement('div');
  document.body.append(container);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  container.innerHTML = renderToString(<I18nProvider initial="en"><CompanyProvider>Private workspace</CompanyProvider></I18nProvider>);
  const recoverableError = vi.fn();
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, <I18nProvider initial="zh-CN"><CompanyProvider>Private workspace</CompanyProvider></I18nProvider>, { onRecoverableError: recoverableError });
    });
    expect(recoverableError).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Private workspace');
  } finally {
    await act(async () => { root?.unmount(); });
    container.remove();
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  }
});
