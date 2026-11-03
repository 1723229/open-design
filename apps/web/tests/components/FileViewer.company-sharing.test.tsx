// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { FileViewer } from '../../src/components/FileViewer';
import { I18nProvider } from '../../src/i18n';
import { resetConsumedActionRequestsForTests } from '../../src/runtime/action-request';
import type { ProjectFile } from '../../src/types';

vi.mock('../../src/company/CompanyProvider', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/company/CompanyProvider')>(),
  useCompany: () => ({ enabled: true, isMember: false, user: { id: 'owner', username: 'Owner', role: 'admin' } }),
}));

const file: ProjectFile = { name: 'index.html', path: 'index.html', type: 'file', size: 100, mtime: 1, kind: 'html', mime: 'text/html', artifactManifest: { version: 1, kind: 'html', title: 'Test page', entry: 'index.html', renderer: 'html', exports: ['html'] } };

beforeEach(() => {
  resetConsumedActionRequestsForTests();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/members')) return Response.json({ members: [{ userId: 'owner', username: 'Project owner', role: 'owner' }], canManage: true });
    if (url === '/api/company/users') return Response.json({ users: [] });
    return Response.json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function viewer(nonce?: number) {
  return <I18nProvider initial="en"><FileViewer projectId="project-1" projectKind="prototype" file={file} liveHtml="<html><body>Test page</body></html>" shareRequest={nonce == null ? null : { nonce }} /></I18nProvider>;
}

it('opens existing project-member sharing from the company toolbar', async () => {
  render(viewer());
  fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
  const dialog = await screen.findByRole('dialog', { name: 'Project sharing' });
  expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
  expect(await within(dialog).findByText('Project owner')).toBeTruthy();
});

it('consumes an artifact-card share request once and opens the same company dialog', async () => {
  const first = render(viewer(12345));
  expect(await screen.findByRole('dialog', { name: 'Project sharing' })).toBeTruthy();
  first.unmount();
  render(viewer(12345));
  expect(screen.queryByRole('dialog', { name: 'Project sharing' })).toBeNull();
});

it('opens the toolbar export menu when a company artifact-card anchor is no longer visible', async () => {
  render(<I18nProvider initial="en"><FileViewer projectId="project-1" projectKind="prototype" file={file} liveHtml="<html><body>Test page</body></html>" downloadRequest={{ nonce: 34567, anchorId: 'offscreen-card' }} /></I18nProvider>);
  expect(await screen.findByRole('menuitem', { name: 'Export as PDF' })).toBeTruthy();
});

it('lets an authenticated local reviewer open the original history panel without enabling restore',async()=>{
  const version={id:'v1',version:1,current:true,createdAt:Date.now(),source:'ai',size:40};
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
    const url=String(input);
    if(url.includes('/members')) return Response.json({members:[],canManage:false,canWrite:false,canComment:true});
    if(url.endsWith('/versions')) return Response.json({file,versions:[version]});
    if(url.endsWith('/versions/v1')) return Response.json({version,content:'<html><body>History</body></html>'});
    return Response.json({});
  }));
  render(<I18nProvider initial="en"><FileViewer projectId="project-1" projectKind="prototype" file={file} viewerOnly liveHtml="<html><body>Test page</body></html>" /></I18nProvider>);
  const entry=await screen.findByRole('button',{name:'Versions'});
  await waitFor(()=>expect((entry as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(entry);
  expect(await screen.findByRole('listbox')).toBeTruthy();
  expect((screen.getByRole('button',{name:'Switch to this version'}) as HTMLButtonElement).disabled).toBe(true);
});
