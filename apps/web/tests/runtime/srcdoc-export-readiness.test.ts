import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

function exportPage(ready?: boolean) {
  const html = `<html${ready === undefined ? '' : ` data-od-preview-ready="${ready}"`}><body>Page</body></html>`;
  const script = buildSrcdoc(html).match(/<script data-od-export-capture-bridge>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Export capture bridge not found');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const capture = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,', w: 100, h: 100 }));
  Object.defineProperty(dom.window, '__odCaptureSnapshot', { value: capture });
  dom.window.eval(script);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {
    type: 'od:export-capture', id: 'readiness-test', mode: 'image', deck: false,
  } }));
  return { dom, capture };
}

it('waits for a page that explicitly declares its loading animation unfinished', async () => {
  const { dom, capture } = exportPage(false);
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(capture).not.toHaveBeenCalled();
    dom.window.document.documentElement.setAttribute('data-od-preview-ready', 'true');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
  } finally { dom.window.close(); }
});

it('exports ordinary pages without requiring a readiness attribute', async () => {
  const { dom, capture } = exportPage();
  try { await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce()); }
  finally { dom.window.close(); }
});
