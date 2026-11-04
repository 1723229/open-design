// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { CompanyTeamsSwitcher } from '../../src/company/CompanyTeams';
import { buildPath, parseRoute } from '../../src/router';

vi.mock('../../src/company/CompanyProvider', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/company/CompanyProvider')>(),
  useCompany: () => ({enabled:true,teamsEnabled:true,user:{id:'alice'}}),
}));
beforeEach(() => { window.history.replaceState({}, '', '/'); });
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
const team = {id:'business',name:'Business',status:'active',source:'external',role:'viewer',canManage:false,canWrite:false,revision:1,stale:false,sourceUrl:'http://source.test/projects/business'};

it('switches spaces from the sidebar menu without saving configuration', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({teams:[team]})); vi.stubGlobal('fetch',fetcher);
  render(<I18nProvider initial="en"><CompanyTeamsSwitcher /></I18nProvider>);
  fireEvent.click(screen.getByTestId('workspace-switcher'));
  fireEvent.click(await screen.findByRole('menuitem',{name:'Business'}));
  await waitFor(() => expect(window.location.pathname).toBe('/teams/business/home'));
  expect(screen.getByTestId('workspace-switcher').textContent).toContain('Business');
  fireEvent.click(screen.getByTestId('workspace-switcher'));
  expect(screen.getByRole('menuitem',{name:'Business'}).getAttribute('aria-current')).toBe('true');
  fireEvent.click(screen.getByRole('menuitem',{name:'Personal space'}));
  await waitFor(() => expect(window.location.pathname).toBe('/'));
  expect(fetcher.mock.calls.every(([,init]) => !init?.method || init.method==='GET')).toBe(true);
});
it('shows inherited external membership with no local editing controls', async () => {
  window.history.replaceState({},'', '/teams/business');
  vi.stubGlobal('fetch',vi.fn(async (url: string) => Response.json(url.endsWith('/business')
    ? {team,members:[{userId:'alice',username:'alice',displayName:'项目成员',role:'viewer'}]} : {teams:[team]})));
  render(<I18nProvider initial="en"><CompanyTeamsSwitcher /></I18nProvider>);
  fireEvent.click(screen.getByTestId('workspace-switcher'));
  fireEvent.click(await screen.findByRole('menuitem',{name:'Team members'}));
  expect(await screen.findByText('项目成员（alice）')).toBeTruthy();
  expect(screen.getByRole('link',{name:'Manage in source platform'}).getAttribute('href')).toBe(team.sourceUrl);
  expect(screen.queryByRole('button',{name:'Add member'})).toBeNull();
});

it('shows real names in local team permissions and member choices', async () => {
  window.history.replaceState({}, '', '/teams/business');
  const local = { ...team, source: 'local', canManage: true, canWrite: true, role: 'owner' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/company/users'
    ? { users: [{ id: 'chen-user', username: 'chenxy', displayName: '陈晓芸', disabled: false }] }
    : url.endsWith('/business') ? { team: local, members: [{ userId: 'li-user', username: 'liym', displayName: '李元明', role: 'editor' }] }
    : { teams: [local] })));
  render(<I18nProvider initial="en"><CompanyTeamsSwitcher /></I18nProvider>);
  fireEvent.click(screen.getByTestId('workspace-switcher'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Team members' }));
  expect(await screen.findByText('李元明（liym）')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: '李元明（liym） Permission' })).toBeTruthy();
  expect(await screen.findByRole('option', { name: '陈晓芸（chenxy）' })).toHaveValue('chen-user');
});

it('keeps an unavailable team selected and disables stale write authority on refresh failure', async () => {
  window.history.replaceState({}, '', '/teams/business');
  const resolved = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({error:'Unavailable'}, {status:503})));
  render(<I18nProvider initial="en"><CompanyTeamsSwitcher onTeamResolved={resolved} /></I18nProvider>);
  fireEvent.click(screen.getByTestId('workspace-switcher'));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByTestId('workspace-switcher').textContent).not.toContain('Personal space');
  expect(window.location.pathname).toBe('/teams/business');
  await waitFor(() => expect(resolved).toHaveBeenLastCalledWith(null));
  expect(screen.getByRole('menuitem',{name:'Personal space'})).toBeTruthy();
});

it('creates a local team only after submitting the existing dialog', async () => {
  const created = {...team,id:'new-team',name:'New team',source:'local',role:'owner',canWrite:true,canManage:true};
  const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return Response.json({team:created,members:[]}); }
    return Response.json({teams:[team, ...(writes.length ? [created] : [])]});
  }));
  render(<I18nProvider initial="en"><CompanyTeamsSwitcher /></I18nProvider>);
  fireEvent.click(screen.getByTestId('workspace-switcher'));
  fireEvent.click(screen.getByRole('menuitem',{name:'Create team'}));
  const dialog = await screen.findByRole('dialog');
  expect(writes).toEqual([]);
  fireEvent.change(within(dialog).getByLabelText('Team name'), {target:{value:'New team'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'Create team'}));
  await waitFor(() => expect(window.location.pathname).toBe('/teams/new-team'));
  expect(writes).toEqual([{name:'New team'}]);
});

it('closes the space menu with Escape while focus remains on its trigger', () => {
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({teams:[team]})));
  render(<I18nProvider initial="en"><CompanyTeamsSwitcher /></I18nProvider>);
  const trigger = screen.getByTestId('workspace-switcher');
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger,{key:'Escape'});
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it.each(['home','plugins','design-systems','settings'] as const)('preserves the selected team through %s navigation and refresh', view => {
  const path = buildPath({kind:'home',view,companyTeamId:'business'});
  expect(path).toBe(`/teams/business/${view}`);
  expect(parseRoute(path)).toEqual({kind:'home',view,companyTeamId:'business'});
});

it.each(['drafts','all-projects'])('opens the team catalog instead of personal collection filters for %s', view => {
  expect(parseRoute(`/teams/business/${view}`)).toEqual({kind:'home',view:'projects',companyTeamId:'business'});
});
