// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanyProvider } from '../../src/company/CompanyProvider';
import { useCompanyProjectReadOnly } from '../../src/company/useCompanyProjectReadOnly';
import { I18nProvider } from '../../src/i18n';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Access({ projectId = 'project-1' }: { projectId?: string | null }) { const readOnly = useCompanyProjectReadOnly(projectId); return <button disabled={readOnly}>Edit project</button>; }
it.each(['viewer', 'editor', 'owner'] as const)('uses server membership to gate project changes for %s', async role => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => Response.json(String(input) === '/api/company/session' ? { enabled: true, user: { id: 'alice', username: 'Alice', role: 'member', mustChangePassword: false }, csrfToken: 'token', presentation: { showAgentIdentity: false, hiddenSettingsSections: ['labs', 'integrations'] } } : { members: [{ userId: 'alice', username: 'Alice', role }], canManage: role === 'owner' })));
  render(<I18nProvider initial="en"><CompanyProvider><Access /></CompanyProvider></I18nProvider>);
  const button = await screen.findByRole('button', { name: 'Edit project' });
  if (role === 'viewer') expect((button as HTMLButtonElement).disabled).toBe(true);
  else await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
});

it('keeps project changes disabled when company membership cannot be verified', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => Response.json(String(input) === '/api/company/session' ? { enabled: true, user: { id: 'alice', username: 'Alice', role: 'member', mustChangePassword: false }, csrfToken: 'token', presentation: { showAgentIdentity: false, hiddenSettingsSections: [] } } : { error: 'Forbidden' }, { status: String(input) === '/api/company/session' ? 200 : 403 })));
  render(<I18nProvider initial="en"><CompanyProvider><Access /></CompanyProvider></I18nProvider>);
  expect((await screen.findByRole('button', { name: 'Edit project' }) as HTMLButtonElement).disabled).toBe(true);
});

it('waits for project creation before checking membership and enables its owner immediately afterwards', async () => {
  const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => Response.json(String(input) === '/api/company/session'
    ? { enabled: true, user: { id: 'alice', username: 'Alice', role: 'member', mustChangePassword: false }, csrfToken: 'token', presentation: { showAgentIdentity: false, hiddenSettingsSections: [] } }
    : { members: [{ userId: 'alice', username: 'Alice', role: 'owner' }], canManage: true }));
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<I18nProvider initial="en"><CompanyProvider><Access projectId={null} /></CompanyProvider></I18nProvider>);
  const button = await screen.findByRole('button', { name: 'Edit project' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/members'))).toHaveLength(0);
  view.rerender(<I18nProvider initial="en"><CompanyProvider><Access projectId="created-project" /></CompanyProvider></I18nProvider>);
  await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/members')).map(([url]) => String(url)))
    .toEqual(['/api/company/projects/created-project/members']);
});
