// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanyProjectMembersResponse } from '@open-design/contracts';
import { CompanySharingDialog } from '../../src/company/CompanyControls';
import { COMPANY_MEMBERS_CHANGED_EVENT } from '../../src/company/useCompanyProjectReadOnly';
import { I18nProvider } from '../../src/i18n';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const owner = { userId: 'owner', username: 'Alice', role: 'owner' as const };
const viewer = { userId: 'reviewer', username: 'Bob', role: 'viewer' as const };
function mount(projectId = 'design-1', onClose = vi.fn()) {
  return render(<I18nProvider initial="en"><CompanySharingDialog projectId={projectId} fileName="index.html" onClose={onClose} /></I18nProvider>);
}
function serve(membership: CompanyProjectMembersResponse) {
  const request = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/company/users') return Response.json({ users: [{ id: 'reviewer', username: 'Bob', role: 'member', source: 'ldap', disabled: false, mustChangePassword: false }] });
    return Response.json(membership);
  });
  vi.stubGlobal('fetch', request);
  return request;
}

it('reuses the share link controls with pending and copied feedback for the authenticated design URL', async () => {
  serve({ members: [owner], canManage: true });
  let finish!: () => void;
  const writeText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const onClose = vi.fn();
  mount('design-1', onClose);
  const copy = await screen.findByRole('button', { name: 'Copy share link' });
  fireEvent.click(copy);
  expect(screen.getByRole('button', { name: 'Copying…' })).toBeDisabled();
  const url = `${window.location.origin}/projects/design-1/files/index.html`;
  expect(writeText).toHaveBeenCalledExactlyOnceWith(url);
  await act(async () => finish());
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeEnabled();
  expect(screen.getByText(url)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(screen.queryByText('Anyone with the link')).toBeNull();
});

it('keeps the link selectable and reports a failed copy without claiming success', async () => {
  serve({ members: [viewer], canManage: false });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Copy share link' }));
  expect(await screen.findByText('Could not copy automatically. Please manually copy the link above.')).toBeVisible();
  expect(screen.getByText(`${window.location.origin}/projects/design-1/files/index.html`)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('preserves member selection, permission changes, removal and permission refresh notifications', async () => {
  let members = [owner, viewer];
  const updates: Array<{ method: string; body?: unknown }> = [];
  const notified = vi.fn();
  window.addEventListener(COMPANY_MEMBERS_CHANGED_EVENT, notified);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/company/users') return Response.json({ users: [{ id: 'reviewer', username: 'Bob', role: 'member', source: 'ldap', disabled: false, mustChangePassword: false }] });
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      updates.push({ method: 'PUT', body });
      members = [owner, { ...viewer, role: body.role }];
    }
    if (init?.method === 'DELETE') { updates.push({ method: 'DELETE' }); members = [owner]; }
    return Response.json({ members, canManage: true });
  }));
  try {
    mount();
    fireEvent.change(await screen.findByLabelText('Bob Permission'), { target: { value: 'editor' } });
    await waitFor(() => expect(screen.getByLabelText('Bob Permission')).toHaveValue('editor'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByLabelText('Bob Permission')).toBeNull());
    fireEvent.change(screen.getByRole('combobox', { name: 'Member' }), { target: { value: 'reviewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByLabelText('Bob Permission')).toHaveValue('viewer');
    expect(updates).toEqual([{ method: 'PUT', body: { userId: 'reviewer', role: 'editor' } }, { method: 'DELETE' }, { method: 'PUT', body: { userId: 'reviewer', role: 'viewer' } }]);
    expect(notified).toHaveBeenCalledTimes(3);
  } finally { window.removeEventListener(COMPANY_MEMBERS_CHANGED_EVENT, notified); }
});

it('keeps team access inherited even when the platform user can manage designs', async () => {
  const request = serve({ members: [owner, viewer], canManage: true, team: { id: 'team-1', name: 'Cbrain project', source: 'external', status: 'active', revision: 1, role: 'admin', canManage: false, canWrite: true, stale: false } });
  mount();
  expect(await screen.findByRole('link', { name: 'Cbrain project' })).toHaveAttribute('href', '/teams/team-1');
  expect(screen.getByText('Access is inherited from the team.')).toBeVisible();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
  expect(request.mock.calls.some(([url]) => url === '/api/company/users')).toBe(false);
});

it('clears the previous design access while loading another design and retries a failed read', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('design-2')
    ? Response.json({ error: 'Forbidden' }, { status: 403 })
    : Response.json({ members: [owner], canManage: false })));
  const view = mount();
  await screen.findByText('Alice');
  view.rerender(<I18nProvider initial="en"><CompanySharingDialog projectId="design-2" onClose={vi.fn()} /></I18nProvider>);
  const error = await screen.findByRole('alert');
  expect(screen.queryByText('Alice')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy share link' })).toBeNull();
  serve({ members: [viewer], canManage: false });
  fireEvent.click(within(error.parentElement!).getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Bob')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('retains the last confirmed permission after a rejected update and allows retrying it', async () => {
  let reject = true;
  let member = viewer;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/company/users') return Response.json({ users: [] });
    if (init?.method === 'PUT') {
      if (reject) return Response.json({ error: 'Forbidden' }, { status: 403 });
      member = { ...viewer, role: JSON.parse(String(init.body)).role };
    }
    return Response.json({ members: [owner, member], canManage: true });
  }));
  mount();
  fireEvent.change(await screen.findByLabelText('Bob Permission'), { target: { value: 'editor' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to save changes. Please retry.');
  expect(screen.getByLabelText('Bob Permission')).toHaveValue('viewer');
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  reject = false;
  fireEvent.change(screen.getByLabelText('Bob Permission'), { target: { value: 'editor' } });
  await waitFor(() => expect(screen.getByLabelText('Bob Permission')).toHaveValue('editor'));
  expect(screen.queryByRole('alert')).toBeNull();
});
