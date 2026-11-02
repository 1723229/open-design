// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanyUsersDialog, CompanySharingDialog, CompanyMemberSettings } from '../../src/company/CompanyControls';
import { I18nProvider } from '../../src/i18n';
import { copyToClipboard } from '../../src/lib/copy-to-clipboard';

vi.mock('../../src/lib/copy-to-clipboard', () => ({ copyToClipboard: vi.fn() }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(copyToClipboard).mockReset(); });

it('copies the exact artifact link while retaining project-member authorization', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ members: [{ userId: 'owner', username: 'Owner', role: 'owner' }], canManage: false })));
  vi.mocked(copyToClipboard).mockResolvedValue(true);
  render(<I18nProvider initial="en"><CompanySharingDialog projectId="project-1" fileName="pages/main design.html" onClose={() => {}} /></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy share link' }));
  await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/projects/project-1/files/pages/main%20design.html`));
  expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
});

it('keeps the link selectable and reports a failed clipboard operation honestly', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ members: [], canManage: false })));
  vi.mocked(copyToClipboard).mockResolvedValue(false);
  render(<I18nProvider initial="en"><CompanySharingDialog projectId="project-1" onClose={() => {}} /></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy share link' }));
  expect(await screen.findByText('Could not copy automatically. Please manually copy the link above.')).toBeTruthy();
  expect(screen.getByRole('textbox').getAttribute('readonly')).not.toBeNull();
});

it('lists and disables a company user through the administrator API', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ users: [{ id: 'alice', username: 'Alice', role: 'member', disabled: false }] }));
  vi.stubGlobal('fetch', fetchMock);
  render(<I18nProvider initial="en"><CompanyUsersDialog onClose={() => {}} currentUserId="admin" /></I18nProvider>);
  await screen.findByText('Alice');
  fetchMock.mockImplementation(async () => Response.json({ users: [{ id: 'alice', username: 'Alice', role: 'member', disabled: true }] }));
  fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/company/users/alice' && init?.method === 'PATCH' && JSON.parse(String(init.body)).disabled === true)).toBe(true));
  await screen.findByRole('button', { name: 'Enable' });
});

it('changes another user role without exposing role changes for the current administrator', async () => {
  let role = 'member';
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') role = JSON.parse(String(init.body)).role;
    return Response.json({ users: [
      { id: 'admin', username: 'admin', role: 'admin', disabled: false },
      { id: 'alice', username: 'Alice', role, disabled: false },
    ] });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<I18nProvider initial="en"><CompanyUsersDialog onClose={() => {}} currentUserId="admin" /></I18nProvider>);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Permission: Alice' }), { target: { value: 'admin' } });
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/company/users/alice' && init?.method === 'PATCH' && JSON.parse(String(init.body)).role === 'admin')).toBe(true));
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Permission: Alice' }) as HTMLSelectElement).value).toBe('admin'));
  expect(screen.queryByRole('combobox', { name: 'Permission: admin' })).toBeNull();
});

it('allows owners to add a viewer and remove a project member', async () => {
  let added = false;
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/company/users') return Response.json({ users: [{ id: 'alice', username: 'Alice', disabled: false }] });
    if (init?.method === 'PUT') added = true;
    if (init?.method === 'DELETE') added = false;
    return Response.json({ members: [{ userId: 'owner', username: 'Owner', role: 'owner' }, ...(added ? [{ userId: 'alice', username: 'Alice', role: 'viewer' }] : [])], canManage: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<I18nProvider initial="en"><CompanySharingDialog projectId="project-1" onClose={() => {}} /></I18nProvider>);
  await screen.findByRole('button', { name: 'Add member' });
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'alice' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
  await screen.findByRole('button', { name: 'Remove' });
  expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/company/projects/project-1/members' && init?.method === 'PUT' && JSON.parse(String(init.body)).role === 'viewer')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/company/projects/project-1/members/alice' && init?.method === 'DELETE')).toBe(true));
});

it('shows participants to a viewer without management actions or user directory lookup', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ members: [{ userId: 'owner', username: 'Project owner', role: 'owner' }], canManage: false }));
  vi.stubGlobal('fetch', fetchMock);
  render(<I18nProvider initial="en"><CompanySharingDialog projectId="project-1" onClose={() => {}} /></I18nProvider>);
  await screen.findByText('Project owner');
  expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/company/users')).toBe(false);
});

it('provides members language settings without shared server configuration', () => {
  render(<I18nProvider initial="en"><CompanyMemberSettings presentation="page" onClose={() => {}} /></I18nProvider>);
  expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
  expect(screen.getByLabelText('Language')).toBeTruthy();
  expect(screen.queryByTestId('settings-nav-execution')).toBeNull();
  expect(screen.queryByLabelText(/API key/i)).toBeNull();
});

it('provisions a local member with a temporary password from the admin users dialog', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ users: [] }));
  vi.stubGlobal('fetch', fetchMock);
  render(<I18nProvider initial="en"><CompanyUsersDialog onClose={() => {}} currentUserId="admin" allowCreate /></I18nProvider>);
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob' } });
  fireEvent.change(screen.getByLabelText('Temporary password'), { target: { value: 'temporary-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/company/users' && init?.method === 'POST' && JSON.parse(String(init.body)).username === 'bob' && JSON.parse(String(init.body)).role === 'member')).toBe(true));
});
