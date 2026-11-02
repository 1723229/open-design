// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanyProvider, useCompany, COMPANY_SESSION_CHANGED_EVENT } from '../../src/company/CompanyProvider';
import { I18nProvider } from '../../src/i18n';

const presentation = { showAgentIdentity: false, hiddenSettingsSections: ['labs', 'integrations'] };
const user = { id: 'member-1', username: 'alice', role: 'member', mustChangePassword: false };
function Protected() {
  const company = useCompany();
  return <><span>Protected workspace</span><button onClick={() => { void fetch('/api/projects', { method: 'POST', body: '{}' }); }}>Create project</button><button onClick={() => { void company.logout(); }}>Log out</button></>;
}
const app = () => <I18nProvider initial="en"><CompanyProvider><Protected /></CompanyProvider></I18nProvider>;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps the original artwork and changes login language without clearing entered credentials', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ enabled: true, user: null, presentation })));
  render(app());
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'entered-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: /简体中文/ }));
  expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('alice');
  expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('entered-password');
  expect(screen.getByRole('heading', { name: '欢迎使用 NexusDesign' })).toBeTruthy();
  expect(document.querySelector('img[src="/onboarding/registration-invite-art.webp"]')).toBeTruthy();
  expect(screen.queryByText('Protected workspace')).toBeNull();
  expect(screen.queryByText('登录 / 注册')).toBeNull();
});

it('gates the workspace, logs in with a single form, and adds CSRF only to same-origin API mutations', async () => {
  const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/company/session') return Response.json({ enabled: true, user: null, presentation });
    if (String(input) === '/api/company/auth/login') return Response.json({ enabled: true, user, presentation, csrfToken: 'csrf-test' });
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(app());
  expect(screen.queryByText('Protected workspace')).toBeNull();
  await screen.findByLabelText('Username');
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('Protected workspace');
  fireEvent.click(screen.getByText('Create project'));
  await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/api/projects' && new Headers(init?.headers).get('x-csrf-token') === 'csrf-test')).toBe(true));
  const request = new Request(new URL('/api/projects/project-1', window.location.href), { method: 'PATCH', headers: { 'x-context': 'project-1' }, body: '{}' });
  await fetch(request, { headers: { 'Content-Type': 'application/json' } });
  const headers = new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers);
  expect(headers.get('x-csrf-token')).toBe('csrf-test');
  expect(headers.get('x-context')).toBe('project-1');
  expect(headers.get('content-type')).toBe('application/json');
  await fetch('https://third-party.test/api/projects', { method: 'POST' });
  expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).has('x-csrf-token')).toBe(false);
});

it('keeps rejected credentials on the login form without exposing private content', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => String(input) === '/api/company/session' ? Response.json({ enabled: true, user: null, presentation }) : Response.json({ error: 'Invalid credentials' }, { status: 401 })));
  render(app());
  await screen.findByLabelText('Username');
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Protected workspace')).toBeNull();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
});

it('requires the bootstrap administrator to change password before mounting the app', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ enabled: true, user: { ...user, role: 'admin', mustChangePassword: true }, presentation, csrfToken: 'csrf-test' })));
  render(app());
  await screen.findByLabelText('Current password');
  expect(screen.queryByText('Protected workspace')).toBeNull();
  expect(screen.getByLabelText('New password')).toBeTruthy();
});

it('preserves local mode when company authentication is disabled', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ enabled: false, user: null, presentation }));
  vi.stubGlobal('fetch', fetchMock);
  render(app());
  await screen.findByText('Protected workspace');
  expect(window.fetch).toBe(fetchMock);
});

it('fails closed when session discovery fails, with a retry action', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')));
  render(app());
  await screen.findByRole('alert');
  expect(screen.queryByText('Protected workspace')).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});

it('fails closed on a malformed session response instead of treating it as local mode', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
  render(app());
  await screen.findByRole('alert');
  expect(screen.queryByText('Protected workspace')).toBeNull();
});

it('uses the browser fetch receiver when discovering the company session', async () => {
  const fetchMock = vi.fn(function (this: unknown) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(Response.json({ enabled: false, user: null, presentation }));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(app());
  await screen.findByText('Protected workspace');
});

it('unmounts private content and restores fetch on logout, requesting a cache-clearing page reload', async () => {
  const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => Response.json(String(input).endsWith('/logout') ? { ok: true } : { enabled: true, user, presentation, csrfToken: 'csrf-test' }));
  vi.stubGlobal('fetch', fetchMock);
  const changed = vi.fn();
  window.addEventListener(COMPANY_SESSION_CHANGED_EVENT, changed);
  render(app());
  await screen.findByText('Protected workspace');
  fireEvent.click(screen.getByText('Log out'));
  await screen.findByLabelText('Username');
  expect(screen.queryByText('Protected workspace')).toBeNull();
  expect(window.fetch).toBe(fetchMock);
  expect(changed).toHaveBeenCalledOnce();
  window.removeEventListener(COMPANY_SESSION_CHANGED_EVENT, changed);
});

it('returns to the login gate when an authenticated API call reports an expired session', async () => {
  const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => String(input) === '/api/company/session' ? Response.json({ enabled: true, user, presentation, csrfToken: 'csrf-test' }) : Response.json({ error: 'Session expired' }, { status: 401 }));
  vi.stubGlobal('fetch', fetchMock);
  render(app());
  await screen.findByText('Protected workspace');
  fireEvent.click(screen.getByText('Create project'));
  await screen.findByLabelText('Username');
  expect(screen.queryByText('Protected workspace')).toBeNull();
  expect(window.fetch).toBe(fetchMock);
});
