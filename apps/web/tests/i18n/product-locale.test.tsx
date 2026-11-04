// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { LanguageMenu } from '../../src/components/LanguageMenu';
import { I18nProvider, useI18n } from '../../src/i18n';

afterEach(() => { cleanup(); window.localStorage.clear(); });

function Probe() {
  const { locale, t } = useI18n();
  return <><span data-testid="locale">{locale}</span><span>{t('settings.general')}</span><LanguageMenu /></>;
}

it.each(['en', 'ja', 'ar'])('uses Chinese even with a saved manual %s preference and an English browser', (savedLocale) => {
  window.localStorage.setItem('open-design:locale', savedLocale);
  window.localStorage.setItem('open-design:locale-source', 'manual');
  Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US'] });
  render(<I18nProvider><Probe /></I18nProvider>);
  expect(screen.getByTestId('locale').textContent).toBe('zh-CN');
  expect(screen.getByText('通用')).toBeTruthy();
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(screen.queryByRole('button')).toBeNull();
  expect(window.localStorage.getItem('open-design:locale')).toBeNull();
  expect(window.localStorage.getItem('open-design:locale-source')).toBeNull();
});
