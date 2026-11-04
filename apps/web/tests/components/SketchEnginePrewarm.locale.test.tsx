// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SketchEnginePrewarm } from '../../src/components/SketchEnginePrewarm';

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({ langCode }: { langCode?: string }) => <span data-testid="engine-language">{langCode ?? 'en'}</span>,
}));

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('prewarms the sketch engine in Chinese instead of its English default', () => {
  vi.useFakeTimers();
  render(<SketchEnginePrewarm />);
  act(() => { vi.advanceTimersByTime(2000); });
  expect(screen.getByTestId('engine-language').textContent).toBe('zh-CN');
});
