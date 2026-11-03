// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanyProvider } from '../../src/company/CompanyProvider';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';
import { I18nProvider } from '../../src/i18n';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import { AvatarMenu } from '../../src/components/AvatarMenu';
import { EntryNavRail, EntryTopRightCluster } from '../../src/components/EntryNavRail';
import { HomeView } from '../../src/components/HomeView';
import { MessageCenter } from '../../src/components/MessageCenter';
import { FileViewer } from '../../src/components/FileViewer';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { MemoryToast } from '../../src/components/MemoryToast';
import { useMemoryWrittenCard } from '../../src/runtime/useMemoryWrittenCard';
import { useProjectDeleteFlow } from '../../src/components/project-actions/useProjectDeleteFlow';
import type { Project } from '../../src/types';

afterEach(() => { cleanup(); document.getElementById('workspace-chrome-account-actions')?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function session(role: 'admin' | 'member') {
  const fetchMock = vi.fn().mockImplementation(async (path: RequestInfo | URL) => Response.json(String(path) === '/api/company/session' ? { enabled: true, user: { id: role, username: role, role, mustChangePassword: false }, csrfToken: 'csrf-test', presentation: { showAgentIdentity: false, hiddenSettingsSections: ['labs', 'integrations'] } } : String(path) === '/api/company/models' ? { revision: 0, providers: [], active: null, agents: [{id:'codex',name:'Codex',protocols:['responses'],installed:true}] } : {}));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const agents = [{ id: 'codex', name: 'Codex', bin: 'codex', available: true }];
const settingsProps = { agents, daemonLive: true, appVersionInfo: null, onPersist: vi.fn(), onPersistComposioKey: vi.fn(), onClose: vi.fn(), onRefreshAgents: vi.fn() };

it.each(['member', 'admin'] as const)('shows the company settings destination only to administrators: %s', async role => {
  session(role);
  render(<I18nProvider initial="en"><CompanyProvider><span>Rail ready</span><EntryNavRail view="home" onViewChange={vi.fn()} onNewProject={vi.fn()} open context={null} onOpenSettings={vi.fn()} /></CompanyProvider></I18nProvider>);
  await screen.findByText('Rail ready');
  expect(screen.queryByTestId('entry-settings-button') !== null).toBe(role === 'admin');
  expect(screen.getByTestId('entry-nav-plugins').textContent).toContain('Skills');
});

it('keeps only files, skills and MCP in the company Home mention picker', async () => {
  session('member');
  render(<I18nProvider initial="en"><CompanyProvider><HomeView projects={[]} onSubmit={() => {}} onOpenProject={() => {}} /></CompanyProvider></I18nProvider>);
  await screen.findByTestId('home-hero-input');
  setHomeHeroPrompt('@');
  await waitFor(() => expect(screen.getByTestId('home-hero-plugin-picker')).toBeTruthy());
  expect(screen.getAllByRole('tab').map(tab => tab.textContent?.replace(/\d+/g, '').trim())).toEqual(['All', 'Design files', 'Skills', 'MCP']);
});

it('allows company project deletion without a disabled official cloud sharing check', async () => {
  const fetchMock = session('admin');
  const onDelete = vi.fn().mockResolvedValue(true);
  const { result } = renderHook(() => useProjectDeleteFlow({ onDelete, analyticsPage: 'all_projects', workspaceContext: null }), {
    wrapper: ({ children }) => <I18nProvider initial="en"><CompanyProvider>{children}</CompanyProvider></I18nProvider>,
  });
  await waitFor(() => expect(result.current).toBeTruthy());
  const project: Project = { id: 'qa-owned', name: 'QA owned', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1, status: { value: 'not_started' } };
  act(() => result.current.request(project));
  expect(result.current.shareReadStatus).toBe('ready');
  expect(result.current.activeShareCount).toBe(0);
  await act(async () => { await result.current.commit(); });
  expect(onDelete).toHaveBeenCalledExactlyOnceWith('qa-owned');
  expect(fetchMock.mock.calls.filter(([path]) => String(path).includes('/share-state'))).toHaveLength(0);
});

it('normalizes member execution deep links onto safe General settings', async () => {
  session('member');
  render(<I18nProvider initial="en"><CompanyProvider><SettingsDialog {...settingsProps} initial={DEFAULT_CONFIG} initialSection="execution" /></CompanyProvider></I18nProvider>);
  await screen.findByRole('heading', { name: 'General' });
  expect(screen.queryByTestId('settings-nav-execution')).toBeNull();
  expect(screen.queryByRole('tablist')).toBeNull();
});

it('uses unified provider and agent administration in company settings', async () => {
  session('admin');
  render(<I18nProvider initial="en"><CompanyProvider><SettingsDialog {...settingsProps} initial={{ ...DEFAULT_CONFIG, mode: 'api', agentId: 'codex' }} initialSection="execution" /></CompanyProvider></I18nProvider>);
  await screen.findByTestId('settings-nav-execution');
  expect(await screen.findByRole('tab', { name: /API providers/ })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('tab', { name: /API providers/ }));
  expect(screen.getByRole('tab', { name: /Custom provider/ })).toBeTruthy();
  expect(screen.getByLabelText('API key')).toBeTruthy();
  expect(document.querySelector('.settings-execution-sticky .seg-control')?.getAttribute('style')).toContain('--seg-cols: 2');
  expect(screen.queryByLabelText('Execution provider')).toBeNull();
});

it('routes administrators to managed settings instead of a legacy inline switch', async () => {
  session('admin');
  const onOpenSettings = vi.fn();
  const props = { config: { ...DEFAULT_CONFIG, agentId: 'codex' }, agents, daemonLive: true, onModeChange: vi.fn(), onAgentChange: vi.fn(), onAgentModelChange: vi.fn(), onApiModelChange: vi.fn(), onApiProtocolChange: vi.fn(), onOpenSettings, onRefreshAgents: vi.fn() };
  render(<I18nProvider initial="en"><CompanyProvider><InlineModelSwitcher {...props} /><AvatarMenu {...props} /></CompanyProvider></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Models & providers' }));
  expect(onOpenSettings).toHaveBeenCalledWith('execution');
  expect(screen.queryByTestId('inline-model-switcher')).toBeNull();
});

it('removes both home and project model selectors for an ordinary member', async () => {
  const fetchMock = session('member');
  const props = { config: { ...DEFAULT_CONFIG, agentId: 'codex' }, agents, daemonLive: true, onModeChange: vi.fn(), onAgentChange: vi.fn(), onAgentModelChange: vi.fn(), onApiModelChange: vi.fn(), onApiProtocolChange: vi.fn(), onOpenSettings: vi.fn(), onRefreshAgents: vi.fn() };
  render(<I18nProvider initial="en"><CompanyProvider><span>Ready</span><InlineModelSwitcher {...props} /><AvatarMenu {...props} /></CompanyProvider></I18nProvider>);
  await screen.findByText('Ready');
  expect(screen.queryByTestId('inline-model-switcher')).toBeNull();
  expect(screen.queryByRole('button', { name: /Codex/ })).toBeNull();
  expect(fetchMock.mock.calls.every(([path]) => path === '/api/company/session')).toBe(true);
});

it('shows company account actions when upstream cloud chrome is disabled and empty', async () => {
  session('admin');
  const host = document.createElement('div');
  host.id = 'workspace-chrome-account-actions';
  document.body.appendChild(host);
  render(<I18nProvider initial="en"><CompanyProvider><EntryTopRightCluster page="home" context={null} /></CompanyProvider></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'admin' }));
  expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'User management' })).toBeTruthy();
});

it('does not probe cloud account or unconfigured media catalogues on company home', async () => {
  const fetchMock = session('admin');
  render(<I18nProvider initial="en"><CompanyProvider><span>Company home mounted</span><HomeView projects={[]} onSubmit={() => {}} onOpenProject={() => {}} /><MessageCenter hideTrigger /></CompanyProvider></I18nProvider>);
  await screen.findByText('Company home mounted');
  expect(fetchMock.mock.calls.filter(([path]) => /\/api\/(integrations\/vela\/status|media\/providers\/aihubmix\/models)/.test(String(path)))).toHaveLength(0);
});

it('keeps company previews from reading legacy cloud project sharing state', async () => {
  const fetchMock = session('admin');
  render(<I18nProvider initial="en"><CompanyProvider><FileViewer projectId="project-1" projectKind="prototype" isDeck file={{ name: 'index.html', path: 'index.html', size: 100, mtime: 1, kind: 'html', mime: 'text/html' }} liveHtml="<html><body>Company preview</body></html>" /></CompanyProvider></I18nProvider>);
  await screen.findByTestId('artifact-preview-frame');
  expect(fetchMock.mock.calls.filter(([path]) => /\/(collab\/status|share-state)(\?|$)/.test(String(path)))).toHaveLength(0);
});

it('opens the export menu when the official sharing entry is hidden', async () => {
  session('admin');
  render(<I18nProvider initial="en"><CompanyProvider><FileViewer projectId="project-1" projectKind="prototype" isDeck file={{ name: 'index.html', path: 'index.html', size: 100, mtime: 1, kind: 'html', mime: 'text/html' }} liveHtml="<html><body>Company preview</body></html>" /></CompanyProvider></I18nProvider>);
  await screen.findByTestId('artifact-preview-frame');
  const button = screen.getByRole('button', { name: 'Export' });
  fireEvent.click(button);
  expect(await screen.findByRole('menuitem', { name: 'Export as PDF' })).toBeTruthy();
});

it('does not request privileged host or integration data for ordinary member home', async () => {
  const fetchMock = session('member');
  render(<I18nProvider initial="en"><CompanyProvider><span>Member home mounted</span><HomeView projects={[]} onSubmit={() => {}} onOpenProject={() => {}} /></CompanyProvider></I18nProvider>);
  await screen.findByText('Member home mounted');
  expect(fetchMock.mock.calls.filter(([path]) => /\/api\/(recent-dirs|mcp\/servers|connectors)/.test(String(path)))).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Working directory' })).toBeNull();
});

it('lets company viewers export a ZIP while retaining disabled editing controls', async () => {
  const fetchMock = session('member');
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<I18nProvider initial="en"><CompanyProvider><FileViewer projectId="project-1" projectKind="prototype" viewerOnly isDeck file={{ name: 'index.html', path: 'index.html', size: 100, mtime: 1, kind: 'html', mime: 'text/html' }} liveHtml="<html><body>Company viewer preview</body></html>" /></CompanyProvider></I18nProvider>);
  await screen.findByTestId('artifact-preview-frame');
  const button = screen.getByRole('button', { name: 'Export' });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === '/api/projects/project-1/archive')).toBe(true));
  await waitFor(() => expect(download).toHaveBeenCalled());
  expect((screen.getByRole('tab', { name: 'Code' }) as HTMLButtonElement).disabled).toBe(true);
});

it('does not subscribe company sessions to global memory events', async () => {
  session('member');
  const eventSource = vi.fn(function () { return { addEventListener: vi.fn(), close: vi.fn() }; });
  vi.stubGlobal('EventSource', eventSource);
  render(<I18nProvider initial="en"><CompanyProvider><span>Memory mounted</span><MemoryToast /></CompanyProvider></I18nProvider>);
  await screen.findByText('Memory mounted');
  expect(eventSource).not.toHaveBeenCalled();
});

it('does not poll global memory extraction after a company turn ends', async () => {
  vi.useFakeTimers();
  const fetchMock = session('member');
  function Probe({ active }: { active: boolean }) {
    useMemoryWrittenCard(active);
    return <span>{active ? 'Turn active' : 'Turn ended'}</span>;
  }
  const view = render(<I18nProvider initial="en"><CompanyProvider><Probe active /></CompanyProvider></I18nProvider>);
  await act(async () => {});
  expect(screen.getByText('Turn active')).toBeTruthy();
  view.rerender(<I18nProvider initial="en"><CompanyProvider><Probe active={false} /></CompanyProvider></I18nProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(fetchMock.mock.calls.filter(([path]) => String(path).startsWith('/api/memory'))).toHaveLength(0);
});
