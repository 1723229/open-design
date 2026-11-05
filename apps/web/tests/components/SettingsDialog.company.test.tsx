// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompanyModelSettingsResponse } from '@open-design/contracts';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { CompanyProvider } from '../../src/company/CompanyProvider';
import { I18nProvider } from '../../src/i18n';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { AppConfig } from '../../src/types';

const analytics = vi.hoisted(() => ({ track: vi.fn(), setConsent: vi.fn(), setIdentity: vi.fn(), setConfigureGlobals: vi.fn(), anonymousId: 'test', sessionId: 'test', newRequestId: () => 'test' }));
vi.mock('../../src/analytics/provider', () => ({ useAnalytics: () => analytics }));

let state: CompanyModelSettingsResponse;
let calls: { path: string; body: Record<string, unknown> }[];
let conflict: string | undefined;
let storedKeys: Record<string, string>;
let probeError: boolean;
let catalogModels: ((body: Record<string, unknown>) => string[]) | undefined;
let pending: { path: string; promise: Promise<void>; release: () => void } | undefined;
const persisted = vi.fn();
const drafts = vi.fn();
function defer(path: string) {
  let release!: () => void;
  pending = { path, promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
  return pending;
}
beforeEach(() => {
  persisted.mockClear(); drafts.mockClear(); calls = []; conflict = undefined; pending = undefined;
  storedKeys = { p1: 'responses-key', p2: 'claude-key' };
  probeError = false; catalogModels = undefined;
  state = {
    revision: 7,
    providers: [
      { id: 'p1', name: 'Micu Codex private record', baseUrl: 'https://custom.example/v1', hasApiKey: true, revision: 2, models: ['gpt-original', 'gpt-alternative'], capabilities: ['gpt-original', 'gpt-alternative'].map(model => ({ model, protocol: 'responses', status: 'supported', testedBy: 'protocol', checkedAt: 1 })) },
      { id: 'p2', name: 'Micu Claude private record', baseUrl: 'https://custom.example/v1', hasApiKey: true, revision: 1, models: ['claude-original'], capabilities: [{ model: 'claude-original', protocol: 'anthropic-messages', status: 'supported', testedBy: 'claude', verification: 'file-write', checkedAt: 1 }] },
    ],
    active: { agentId: 'codex', providerId: 'p1', providerName: 'Micu Codex private record', providerRevision: 2, model: 'gpt-original', protocol: 'responses', activatedAt: 1, verifiedAt: 1 },
    agents: [{ id: 'codex', name: 'Codex', installed: true, protocols: ['responses'] }, { id: 'claude', name: 'Claude Code', installed: true, protocols: ['anthropic-messages'] }, { id: 'opencode', name: 'OpenCode', installed: true, protocols: ['chat-completions', 'responses', 'anthropic-messages'] }],
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/company/session') return Response.json({ enabled: true, user: { id: 'admin', username: 'admin', role: 'admin', mustChangePassword: false }, csrfToken: 'test', presentation: { showAgentIdentity: false, hiddenSettingsSections: ['labs', 'integrations'] } });
    if (url === '/api/codex-pets') return Response.json({ pets: [], rootDir: '' });
    if (!url.startsWith('/api/company/models')) return Response.json({});
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method) calls.push({ path: url, body });
    if (pending && url.endsWith(pending.path)) await pending.promise;
    if (conflict && url.endsWith(conflict)) return Response.json({ error: 'Settings changed; retry', code: 'revision_conflict' }, { status: 409 });
    if (url.endsWith('/catalog')) return Response.json({ models: catalogModels?.(body) ?? ['gpt-original', 'gpt-alternative', 'claude-original'] });
    if (url.endsWith('/providers')) {
      const index = state.providers.findIndex(p => p.id === body.id);
      const value = { ...(state.providers[index] ?? state.providers[0]), ...body, id: body.id ?? 'p3', revision: 3, capabilities: [], hasApiKey: true };
      value.baseUrl = new URL(value.baseUrl).pathname === '/' ? `${value.baseUrl.replace(/\/+$/, '')}/v1` : value.baseUrl;
      if (value.maxTokens === null) delete value.maxTokens;
      if (body.apiKey) storedKeys[value.id] = body.apiKey;
      delete value.apiKey;
      if (index < 0) state.providers.push(value); else state.providers[index] = value;
      state.revision++;
    }
    if (init?.method === 'DELETE') { state.providers = state.providers.filter(p => !url.endsWith(`/${p.id}`)); state.revision++; }
    if (url.endsWith('/test')) {
      state.providers.find(p => p.id === body.providerId)!.capabilities = [{ model: body.model, protocol: body.model === 'claude-original' || storedKeys[String(body.providerId)] === 'messages-key' ? 'anthropic-messages' : 'responses', status: probeError ? 'error' : body.model === 'unsupported-model' ? 'unsupported' : 'supported', testedBy: body.agentId, verification: 'file-write', checkedAt: Date.now() }]; state.revision++;
    }
    if (url.endsWith('/activate')) {
      const provider = state.providers.find(p => p.id === body.providerId)!;
      state.active = { ...state.active!, agentId: body.agentId, providerId: provider.id, providerName: provider.name, providerRevision: provider.revision, model: body.model, protocol: body.protocol, verifiedAt: 2 }; state.revision++;
    }
    return Response.json(state);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function Parent() {
  const [initial, setInitial] = useState<AppConfig>({ ...DEFAULT_CONFIG, agentId: 'codex', agentModels: { codex: { model: 'gpt-original' } } });
  return <SettingsDialog initial={initial} initialSection="execution" agents={[]} daemonLive appVersionInfo={null} onPersist={async next => { persisted(next); setInitial(next); }} onPersistComposioKey={async () => {}} onDraftChange={drafts} onClose={() => {}} onRefreshAgents={async () => []} />;
}
async function open() {
  render(<I18nProvider initial="en"><CompanyProvider><Parent /></CompanyProvider></I18nProvider>);
  await screen.findByTestId('settings-agent-card-codex');
}
function api() { fireEvent.click(screen.getByRole('tab', { name: /API providers/ })); }
function cli() { fireEvent.click(screen.getByRole('tab', { name: /Local CLI/ })); }
function custom(protocol: 'OpenAI' | 'Anthropic') {
  fireEvent.click(screen.getByRole('tab', { name: protocol }));
  fireEvent.click(screen.getByRole('tab', { name: 'Custom provider' }));
}
function key(value: string) { fireEvent.change(screen.getByLabelText('API key'), { target: { value } }); }
function model(value: string) {
  fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
  const known = screen.queryByRole('option', { name: new RegExp(value) });
  fireEvent.click(known ?? screen.getByRole('option', { name: 'Custom (type below)…' }));
  if (!known) fireEvent.change(screen.getByLabelText('Custom model id'), { target: { value } });
}
const mutations = (suffix: string) => calls.filter(c => c.path.endsWith(suffix));

it('discovers first-time custom models without choosing, saving or activating a model', async () => {
  state.providers = []; state.active = null;
  catalogModels = () => ['discovered-model'];
  await open(); api(); custom('OpenAI');
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://first.example/v1' } });
  key('first-key'); fireEvent.blur(screen.getByLabelText('API key'));
  await waitFor(() => expect(mutations('/catalog').at(-1)?.body).toEqual({ baseUrl: 'https://first.example/v1', apiKey: 'first-key', protocol: 'openai' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
  expect(mutations('/providers')).toHaveLength(0);
  expect(mutations('/test')).toHaveLength(0);
  expect(mutations('/activate')).toHaveLength(0);
  fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
  fireEvent.click(screen.getByRole('option', { name: /discovered-model/ }));
  await waitFor(() => expect(mutations('/providers').at(-1)?.body.models).toEqual(['discovered-model']));
  expect(mutations('/activate')).toHaveLength(0);
});

it('does not overwrite another provider form with an earlier catalog response', async () => {
  catalogModels = body => body.protocol === 'anthropic' ? ['new-claude-model'] : ['old-gpt-model'];
  const request = defer('/catalog');
  await open(); api();
  await waitFor(() => expect(mutations('/catalog')).toHaveLength(1));
  custom('Anthropic');
  await waitFor(() => expect(mutations('/catalog')).toHaveLength(2));
  await act(async () => request.release());
  await waitFor(() => expect(screen.getByText(/Loaded 1 model/)).toBeTruthy());
  fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
  expect(screen.getByRole('option', { name: /new-claude-model/ })).toBeTruthy();
  expect(screen.queryByRole('option', { name: /old-gpt-model/ })).toBeNull();
  expect(mutations('/providers')).toHaveLength(0);
});

it('keeps manual model input available for an empty catalog without saving discovery', async () => {
  catalogModels = () => [];
  await open(); api();
  await waitFor(() => expect(mutations('/catalog')).toHaveLength(1));
  await screen.findByText(/No compatible text models were returned/);
  model('manual-model');
  await waitFor(() => expect(mutations('/providers').at(-1)?.body.models).toContain('manual-model'));
  expect(mutations('/activate')).toHaveLength(0);
});

it('makes the effective Agent and provider explicit in both tabs while drafts leave the status unchanged', async () => {
  state.active!.baseUrl = 'https://effective-relay.example/v1';
  await open();
  const status = screen.getByTestId('company-model-effective');
  expect(status).toHaveTextContent('Codex'); expect(status).toHaveTextContent('gpt-original');
  expect(status).toHaveTextContent('https://effective-relay.example/v1');
  expect(within(screen.getByTestId('settings-agent-card-codex')).getByText('In use')).toBeTruthy();
  expect(within(screen.getByTestId('settings-agent-card-claude')).queryByText('In use')).toBeNull();
  api(); model('gpt-alternative');
  expect(status).toHaveTextContent('gpt-original'); expect(status).not.toHaveTextContent('gpt-alternative');
  expect(mutations('/activate')).toHaveLength(0);
});

it('keeps the In use badge on the actual Agent when selecting a different Agent fails', async () => {
  conflict = '/activate';
  await open();
  fireEvent.click(screen.getByTestId('settings-agent-select-claude'));
  await waitFor(() => expect(mutations('/activate').length).toBeGreaterThan(0));
  expect(within(screen.getByTestId('settings-agent-card-codex')).getByText('In use')).toBeTruthy();
  expect(within(screen.getByTestId('settings-agent-card-claude')).queryByText('In use')).toBeNull();
  expect(screen.getByTestId('company-model-effective')).toHaveTextContent('Codex');
});

it('adapts OpenCode to the verified Responses model using the original CLI card without rewriting the provider', async () => {
  await open();
  fireEvent.click(screen.getByTestId('settings-agent-select-opencode'));
  await waitFor(() => expect(state.active).toMatchObject({ agentId: 'opencode', model: 'gpt-original', protocol: 'responses' }));
  expect(mutations('/activate').at(-1)?.body).toMatchObject({ agentId: 'opencode', providerId: 'p1', model: 'gpt-original', protocol: 'responses' });
  expect(mutations('/providers')).toHaveLength(0);
  expect(screen.getByTestId('settings-agent-card-opencode')).toHaveTextContent('gpt-original');
});

it('adapts OpenCode to generic Messages proof and passes the original form protocol to model discovery', async () => {
  state.providers[1]!.capabilities[0]!.testedBy = 'protocol';
  state.active = { ...state.active!, agentId: 'claude', providerId: 'p2', model: 'claude-original', protocol: 'anthropic-messages' };
  await open();
  fireEvent.click(screen.getByTestId('settings-agent-select-opencode'));
  await waitFor(() => expect(state.active).toMatchObject({ agentId: 'opencode', model: 'claude-original', protocol: 'anthropic-messages' }));
  api();
  await waitFor(() => expect(mutations('/catalog').at(-1)?.body).toEqual({ providerId: 'p2', protocol: 'anthropic' }));
  expect(mutations('/providers')).toHaveLength(0);
});

it('does not offer Claude-only Messages evidence to OpenCode and retains a compatible configured model', async () => {
  state.providers[1]!.capabilities[0]!.testedBy = 'claude';
  state.active = { ...state.active!, agentId: 'claude', providerId: 'p2', model: 'claude-original', protocol: 'anthropic-messages' };
  await open();
  fireEvent.click(screen.getByTestId('settings-agent-select-opencode'));
  await waitFor(() => expect(state.active).toMatchObject({ agentId: 'opencode', model: 'gpt-original', protocol: 'responses' }));
  expect(mutations('/providers')).toHaveLength(0);
});

it('prefers Claude native file evidence over hydrated GPT generic Messages discovery', async () => {
  state.providers[0]!.capabilities.push({ model: 'gpt-original', protocol: 'anthropic-messages', status: 'supported', testedBy: 'protocol', checkedAt: Date.now() });
  state.providers[1]!.capabilities[0]!.testedBy = 'claude';
  state.providers[1]!.capabilities[0]!.verification = 'file-write';
  await open();
  fireEvent.click(screen.getByTestId('settings-agent-select-claude'));
  await waitFor(() => expect(state.active).toMatchObject({ agentId: 'claude', providerId: 'p2', model: 'claude-original', protocol: 'anthropic-messages' }));
  expect(mutations('/providers')).toHaveLength(0);
});

it('does not save or show Saving for hydration, tab navigation or browsing original provider presets', async () => {
  await open();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  expect(persisted).not.toHaveBeenCalled();
  expect(document.querySelector('.settings-autosave.is-saving, .settings-autosave.is-pending')).toBeNull();
  for (const [name, action] of [['api', api], ['cli', cli], ['api again', api],
    ['OpenAI', () => fireEvent.click(screen.getByRole('tab', { name: 'OpenAI' }))],
    ['Custom', () => fireEvent.click(screen.getByRole('tab', { name: 'Custom provider' }))],
  ] as const) {
    action();
    expect(document.querySelector('.settings-autosave.is-saving, .settings-autosave.is-pending'), name).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  }
  expect(persisted).not.toHaveBeenCalled();
  expect(mutations('/providers')).toHaveLength(0);
  expect(mutations('/activate')).toHaveLength(0);
  expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', 'Already configured; leave blank to keep.');
  expect(storedKeys).toEqual({ p1: 'responses-key', p2: 'claude-key' });
});

it('uses the original provider form without a multi-configuration management bar', async () => {
  await open(); api();
  expect(screen.getByRole('tab', { name: /Custom provider/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('combobox', { name: 'Saved relay' })).toBeNull();
  expect(screen.queryByLabelText('Relay name')).toBeNull();
  for (const name of ['New relay', 'Rename relay', 'Delete relay']) expect(screen.queryByRole('button', { name })).toBeNull();
  expect(screen.queryByText(/Micu/)).toBeNull();
  expect(screen.queryByRole('tab', { name: /Micu/ })).toBeNull();
  expect(screen.queryByLabelText('Execution provider')).toBeNull();
  for (const name of ['Save provider', 'Activate configuration', 'Refresh', 'Fetch models']) expect(screen.queryByRole('button', { name })).toBeNull();
  expect(screen.queryByTestId('settings-byok-no-file-tools-trigger')).toBeNull();
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', 'Already configured; leave blank to keep.');
  expect(screen.getAllByText('Keys are stored on the company server.')).toHaveLength(1);
  expect(screen.getByRole('tab', { name: 'Custom provider' }).querySelector('.is-configured')).toBeTruthy();
});

it('restores a saved provider through the original preset draft mechanism without saving it again', async () => {
  state.providers[1]!.baseUrl = 'https://api.anthropic.com/v1';
  await open(); api();
  fireEvent.click(screen.getByRole('tab', { name: 'Anthropic' }));
  expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.anthropic.com/v1');
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('claude-original'));
  expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', 'Already configured; leave blank to keep.');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  expect(persisted).not.toHaveBeenCalled();
  expect(mutations('/providers')).toHaveLength(0);
  expect(mutations('/activate')).toHaveLength(0);
});

it('retains an invalid intermediate limit while editing and does not clear the saved cap', async () => {
  state.providers[0]!.maxTokens = 12000;
  await open(); api();
  const input = screen.getByRole('spinbutton') as HTMLInputElement;
  expect(input.value).toBe('12000');
  fireEvent.change(input, { target: { value: '1200' } });
  fireEvent.change(input, { target: { value: '120' } });
  expect(input.value).toBe('120');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  expect(mutations('/providers')).toHaveLength(0);
  fireEvent.blur(input);
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  expect(input.value).toBe('120');
  expect(mutations('/providers')).toHaveLength(0);
  expect(state.providers[0]!.maxTokens).toBe(12000);
});

it('preserves another provider key draft when the current provider finishes saving', async () => {
  await open(); api(); key('pending-custom-key');
  fireEvent.click(screen.getByRole('tab', { name: 'OpenAI' })); key('new-openai-key');
  await waitFor(() => expect(mutations('/providers')).toHaveLength(1));
  await waitFor(() => expect(screen.getByLabelText('API key')).toHaveValue(''));
  fireEvent.click(screen.getByRole('tab', { name: 'Custom provider' }));
  expect(screen.getByLabelText('API key')).toHaveValue('pending-custom-key');
});

it('centrally autosaves max tokens once and settles with a parent that feeds saved config back', async () => {
  await open(); api();
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '12000' } });
  fireEvent.blur(screen.getByRole('spinbutton'));
  await waitFor(() => expect(mutations('/providers')[0]?.body).toMatchObject({ id: 'p1', maxTokens: 12000 }));
  await waitFor(() => expect(document.querySelector('.settings-autosave.is-saving, .settings-autosave.is-pending')).toBeNull(), { timeout: 4000 });
  const writes = persisted.mock.calls.length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1000)); });
  expect(mutations('/providers')).toHaveLength(1);
  expect(persisted.mock.calls).toHaveLength(writes);
  expect(document.querySelector('.settings-autosave.is-saving, .settings-autosave.is-pending')).toBeNull();
  expect(mutations('/activate')).toHaveLength(0);
});

it('uses original automatic catalog and keeps a blank configured key valid', async () => {
  await open(); api();
  await waitFor(() => expect(mutations('/catalog')[0]?.body).toEqual({ providerId: 'p1', protocol: 'openai' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
  expect(screen.getByRole('option', { name: /gpt-alternative/ })).toBeTruthy();
  expect(mutations('/providers')).toHaveLength(0);
  expect(mutations('/activate')).toHaveLength(0);
});

it('repairs a same-protocol authentication failure with a typed key only at the protected endpoint', async () => {
  state.providers[0]!.capabilities = [{ model: 'gpt-original', protocol: 'responses', status: 'error', checkedAt: 1 }];
  await open(); api(); key('secret-only-on-server');
  fireEvent.blur(screen.getByLabelText('API key'));
  await waitFor(() => expect(screen.getByLabelText('API key')).toHaveValue(''));
  expect(mutations('/providers')).toHaveLength(1);
  expect(mutations('/providers')[0]?.body.id).toBe('p1');
  expect(mutations('/providers')[0]?.body.apiKey).toBe('secret-only-on-server');
  expect(JSON.stringify(persisted.mock.calls)).not.toContain('secret-only-on-server');
  expect(JSON.stringify(drafts.mock.calls)).not.toContain('secret-only-on-server');
});

it('selects an agent with only compatible configured models and applies exactly the displayed model', async () => {
  await open(); fireEvent.click(screen.getByTestId('settings-agent-select-claude'));
  const card = screen.getByTestId('settings-agent-card-claude');
  expect(within(card).getByRole('combobox')).toHaveTextContent('claude-original');
  fireEvent.click(within(card).getByRole('combobox'));
  expect(screen.queryByRole('option', { name: /gpt-original/ })).toBeNull();
  fireEvent.keyDown(screen.getByTestId('settings-agent-model-popover-claude'), { key: 'Escape' });
  await waitFor(() => expect(mutations('/activate')[0]?.body).toMatchObject({ agentId: 'claude', providerId: 'p2', model: 'claude-original' }));
  expect(within(card).getByText(/Effective configuration/)).toBeTruthy();
  api();
  expect(screen.getByRole('tab', { name: /Custom provider/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('API key')).toHaveValue('');
});

it('applies a compatible original CLI model selection without an activation button', async () => {
  await open(); const card = screen.getByTestId('settings-agent-card-codex');
  fireEvent.click(within(card).getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: 'gpt-alternative' }));
  await waitFor(() => expect(mutations('/activate')[0]?.body).toMatchObject({ agentId: 'codex', providerId: 'p1', model: 'gpt-alternative' }));
  expect(within(card).getByRole('combobox')).toHaveTextContent('gpt-alternative');
});

it('original Test probes then applies only the selected compatible agent', async () => {
  await open(); api(); fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  expect(await screen.findByText(/Connection test passed/)).toBeTruthy();
  expect(mutations('/test')[0]?.body).toMatchObject({ providerId: 'p1', model: 'gpt-original', agentId: 'codex', protocol: 'responses' });
  expect(mutations('/activate')[0]?.body).toMatchObject({ agentId: 'codex', providerId: 'p1', model: 'gpt-original' });
});

it('keeps the original API model picker, active badge and CLI picker consistent after changing a model', async () => {
  await open(); api(); model('gpt-alternative');
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await waitFor(() => expect(state.active?.model).toBe('gpt-alternative'));
  cli();
  const card = screen.getByTestId('settings-agent-card-codex');
  expect(within(card).getByText(/Effective configuration/)).toHaveTextContent('gpt-alternative');
  expect(within(card).getByRole('combobox')).toHaveTextContent('gpt-alternative');
});

it.each(['gpt-original', 'gpt-alternative'])('retries stored credentials for %s after a transient native probe error without replacing them', async testedModel => {
  await open(); api();
  if (testedModel !== 'gpt-original') model(testedModel);
  probeError = true;
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await waitFor(() => expect(state.providers[0]!.capabilities[0]?.status).toBe('error'));
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', 'Already configured; leave blank to keep.');
  expect(state.active?.providerId).toBe('p1');
  expect(mutations('/activate')).toHaveLength(0);
  probeError = false;
  const request = defer('/test');
  fireEvent.click(await screen.findByRole('button', { name: /Retry/ }));
  await waitFor(() => expect(mutations('/test')).toHaveLength(2));
  expect(mutations('/test').every(call => call.body.providerId === 'p1' && call.body.model === testedModel)).toBe(true);
  expect(state.active?.providerId).toBe('p1');
  expect(state.active?.model).toBe('gpt-original');
  expect(mutations('/activate')).toHaveLength(0);
  await act(async () => request.release());
  expect(await screen.findByText(/Connection test passed/)).toBeTruthy();
  expect(mutations('/activate')[0]?.body.providerId).toBe('p1');
  expect(state.active?.model).toBe(testedModel);
  expect(mutations('/providers')).toHaveLength(0);
  expect(storedKeys.p1).toBe('responses-key');
});

it('unsupported Test preserves the prior effective route', async () => {
  await open(); api(); model('unsupported-model');
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await waitFor(() => expect(mutations('/test')).toHaveLength(1));
  expect(await screen.findByText(/unsupported/i)).toBeTruthy();
  expect(mutations('/activate')).toHaveLength(0);
  expect(state.active?.model).toBe('gpt-original');
});

it('a canonicalizing autosave keeps provider identity and never creates a duplicate', async () => {
  await open(); api();
  fireEvent.change(screen.getByDisplayValue('https://custom.example/v1'), { target: { value: 'https://new.example' } });
  key('new-secret'); fireEvent.blur(screen.getByLabelText('API key'));
  expect(await screen.findByDisplayValue('https://new.example/v1')).toBeTruthy();
  expect(screen.getByLabelText('API key')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await waitFor(() => expect(mutations('/activate')[0]?.body.providerId).toBe('p1'));
  expect(mutations('/providers')).toHaveLength(1);
});

it('a deferred autosave cannot clear a newer key', async () => {
  await open(); api(); const request = defer('/providers'); key('submitted-key');
  await waitFor(() => expect(mutations('/providers')).toHaveLength(1));
  key('newer-key');
  await act(async () => request.release());
  expect(screen.getByLabelText('API key')).toHaveValue('newer-key');
});

it('a deferred test cannot apply or report success for a newer model draft', async () => {
  await open(); api(); const request = defer('/test');
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await waitFor(() => expect(mutations('/test')).toHaveLength(1));
  model('gpt-alternative'); await act(async () => request.release());
  expect(screen.queryByText(/Connection test passed/)).toBeNull();
  expect(mutations('/activate')).toHaveLength(0);
});

it('a deferred catalog failure cannot pollute the newer model draft', async () => {
  await open(); const request = defer('/catalog'); api();
  await waitFor(() => expect(mutations('/catalog')).toHaveLength(1));
  model('gpt-alternative'); conflict = '/catalog'; await act(async () => request.release());
  expect(screen.queryByText(/Settings changed; retry/)).toBeNull();
});

it('recognizes the original Anthropic preset after canonical URL normalization', async () => {
  state.active = { ...state.active!, agentId: 'claude', protocol: 'anthropic-messages' };
  state.providers[0]!.baseUrl = 'https://api.anthropic.com/v1';
  state.providers[0]!.capabilities = [{ model: 'gpt-original', protocol: 'anthropic-messages', status: 'supported', testedBy: 'claude', verification: 'file-write', checkedAt: 1 }];
  await open(); api();
  expect(screen.getByRole('tab', { name: /^Anthropic/ })).toHaveAttribute('aria-selected', 'true');
});
it('preserves API autosave when leaving the API pane before its debounce fires', async () => {
  await open(); api();
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '12000' } });
  cli();
  await waitFor(() => expect(mutations('/providers')[0]?.body).toMatchObject({ id: 'p1', maxTokens: 12000 }));
  expect(mutations('/activate')).toHaveLength(0);
});
it('preserves the blank-key max tokens draft through an API CLI API round trip before autosave', async () => {
  await open(); api();
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '12000' } });
  cli(); api();
  expect(screen.getByRole('spinbutton')).toHaveValue(12000);
  await waitFor(() => expect(mutations('/providers')[0]?.body).toMatchObject({ id: 'p1', maxTokens: 12000 }));
  await waitFor(() => expect(document.querySelector('.settings-autosave.is-saving, .settings-autosave.is-pending')).toBeNull());
  expect(mutations('/providers')).toHaveLength(1);
  expect(mutations('/activate')).toHaveLength(0);
});

it('keeps same-host same-model keys separate when the new native protocol is explicitly unsupported by the old record', async () => {
  state.providers = [state.providers[0]!];
  state.providers[0]!.capabilities.push({ model: 'gpt-original', protocol: 'anthropic-messages', status: 'unsupported', checkedAt: 1 });
  await open(); fireEvent.click(screen.getByTestId('settings-agent-select-claude')); api();
  model('gpt-original');
  expect(screen.getByLabelText('API key')).not.toHaveAttribute('placeholder', 'Already configured; leave blank to keep.');
  key('messages-key');
  await waitFor(() => expect(mutations('/providers')).toHaveLength(1));
  expect(mutations('/providers')[0]?.body.id).toBeUndefined();
  expect(storedKeys).toMatchObject({ p1: 'responses-key', p3: 'messages-key' });
  expect(state.providers.find(p => p.id === 'p1')?.capabilities).toEqual(expect.arrayContaining([expect.objectContaining({ protocol: 'responses', status: 'supported' })]));
  expect(state.active?.providerId).toBe('p1');
  expect(mutations('/activate')).toHaveLength(0);
  const request = defer('/test');
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await waitFor(() => expect(mutations('/test')[0]?.body).toMatchObject({ providerId: 'p3', model: 'gpt-original' }));
  expect(state.active?.providerId).toBe('p1');
  await act(async () => request.release());
  await waitFor(() => expect(mutations('/activate')[0]?.body).toMatchObject({ providerId: 'p3', agentId: 'claude', model: 'gpt-original' }));
  expect(storedKeys.p1).toBe('responses-key');
});
it('probes a configured model whose new key has cleared its prior capability proof before applying the agent', async () => {
  await open(); fireEvent.click(screen.getByTestId('settings-agent-select-claude'));
  await waitFor(() => expect(mutations('/activate')).toHaveLength(1));
  api(); key('rotated-claude-key');
  await waitFor(() => expect(mutations('/providers')).toHaveLength(1));
  expect(state.providers.find(p => p.id === 'p2')?.capabilities).toHaveLength(0);
  // A different route is effective when the newly configured Claude model is consumed.
  cli(); fireEvent.click(screen.getByTestId('settings-agent-select-codex'));
  await waitFor(() => expect(state.active?.agentId).toBe('codex'));
  fireEvent.click(screen.getByTestId('settings-agent-select-claude'));
  await waitFor(() => expect(state.active?.agentId).toBe('claude'));
  expect(mutations('/test').filter(c => c.body.providerId === 'p2').length).toBeGreaterThanOrEqual(2);
  expect(within(screen.getByTestId('settings-agent-card-claude')).getByRole('combobox')).toHaveTextContent('claude-original');
});

it('opens the native API protocol for an agent without a compatible configured record', async () => {
  state.providers = [state.providers[0]!];
  state.providers[0]!.capabilities.push({ model: 'gpt-original', protocol: 'anthropic-messages', status: 'unsupported', checkedAt: 1 });
  await open(); fireEvent.click(screen.getByTestId('settings-agent-select-claude'));
  await waitFor(() => expect(screen.getByTestId('settings-agent-select-claude')).toHaveAttribute('aria-pressed', 'true'));
  api();
  expect(screen.getByRole('heading', { name: 'Anthropic API' })).toBeTruthy();
  expect(mutations('/activate')).toHaveLength(0);
});
it('still saves ordinary preferences when no provider has been configured', async () => {
  state.providers = []; state.active = null;
  await open();
  fireEvent.click(screen.getByRole('button', { name: /^General/ }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Completion sound' })).getByRole('button', { name: 'inactive' }));
  await waitFor(() => expect(persisted.mock.calls.some(([config]) => config.notifications?.soundEnabled === false)).toBe(true));
  expect(mutations('/providers')).toHaveLength(0);
});
it('gap: retains the currently effective relay when two relays expose the same Claude model ID', async () => {
 const old=state.providers[1]!;old.capabilities[0]!.testedBy='claude';
 state.providers.push({...structuredClone(old),id:'p3',name:'Other relay',baseUrl:'https://other-relay.example/v1'});
 storedKeys.p3='fixture-only-key';
 state.active={...state.active!,agentId:'claude',providerId:'p3',providerRevision:1,model:'claude-original',protocol:'anthropic-messages',baseUrl:'https://other-relay.example/v1'};
 await open();
 fireEvent.click(screen.getByTestId('settings-agent-select-claude'));
 await waitFor(()=>expect(mutations('/activate').length).toBeGreaterThan(0));
 expect(mutations('/activate').at(-1)!.body.providerId).toBe('p3');
});

it('retains the active same-model relay when switching to OpenCode without a remembered model', async () => {
  const first = state.providers[0]!;
  first.models = ['gpt-original'];
  first.capabilities = (['codex', 'opencode'] as const).map(testedBy => ({ model: 'gpt-original', protocol: 'responses', status: 'supported', testedBy, verification: 'file-write', checkedAt: Date.now() }));
  state.providers.push({ ...structuredClone(first), id: 'p3', name: 'Active Responses relay', baseUrl: 'https://active-relay.example/v1' });
  storedKeys.p3 = 'active-relay-key';
  state.active = { ...state.active!, providerId: 'p3', providerName: 'Active Responses relay', baseUrl: 'https://active-relay.example/v1' };
  await open();
  expect(mutations('/activate')).toHaveLength(0);
  fireEvent.click(screen.getByTestId('settings-agent-select-opencode'));
  await waitFor(() => expect(state.active).toMatchObject({ agentId: 'opencode', providerId: 'p3', model: 'gpt-original', protocol: 'responses' }));
  expect(mutations('/activate')).toHaveLength(1);
  expect(mutations('/activate')[0]?.body).toMatchObject({ agentId: 'opencode', providerId: 'p3', model: 'gpt-original', protocol: 'responses' });
  expect(mutations('/activate').some(call => call.body.providerId === 'p1')).toBe(false);
  expect(mutations('/test')).toHaveLength(0);
});

it('restores the custom Anthropic provider without writes and edits its ID after changing URL', async () => {
 await open(); api(); custom('Anthropic');
 expect(screen.getByLabelText('API key')).toHaveValue('');
 await act(async()=>{await new Promise(r=>setTimeout(r,500));});
 expect(mutations('/providers')).toHaveLength(0); expect(mutations('/activate')).toHaveLength(0);
 fireEvent.change(screen.getByLabelText('Base URL'),{target:{value:'https://edited.example/v1'}});
 await waitFor(()=>expect(mutations('/providers')[0]?.body).toMatchObject({id:'p2',baseUrl:'https://edited.example/v1'}));
});
it('retains a typed key in its own record while switching agents and original provider presets', async () => {
 await open();api();key('unsaved-original');cli();fireEvent.click(screen.getByTestId('settings-agent-select-claude'));
 await waitFor(()=>expect(state.active?.providerId).toBe('p2'));api();
 expect(screen.getByLabelText('API key')).toHaveValue('');
 custom('OpenAI');
 expect(screen.getByLabelText('API key')).toHaveValue('unsaved-original');
});
it('API Test applies the provider selected through original presets and retains the active route on failure', async () => {
 state.providers.push({...structuredClone(state.providers[0]!),id:'p3',name:'OpenAI provider',baseUrl:'https://api.openai.com/v1'});
 await open();api();fireEvent.click(screen.getByRole('tab',{name:'OpenAI'}));
 conflict='/activate';fireEvent.click(screen.getByRole('button',{name:'Test'}));
 await waitFor(()=>expect(mutations('/activate')[0]?.body.providerId).toBe('p3'));
 expect(state.active?.providerId).toBe('p1');
 conflict=undefined;fireEvent.click(await screen.findByRole('button',{name:/Retry/}));
 await waitFor(()=>expect(state.active?.providerId).toBe('p3'));
 expect(mutations('/providers')).toHaveLength(0);
});
it('a deferred save for another provider preset cannot clear the current key draft', async () => {
 await open();api();const request=defer('/providers');key('first-key');
 await waitFor(()=>expect(mutations('/providers')).toHaveLength(1));
 custom('Anthropic');key('second-key');
 await act(async()=>request.release());expect(screen.getByLabelText('API key')).toHaveValue('second-key');
});

it('restores legacy Messages through the original custom provider form without saving', async () => {
  const original = structuredClone(state.providers[1]);
  await open(); api();
  custom('Anthropic');
  expect(screen.getByRole('heading', { name: 'Anthropic API' })).toBeTruthy();
  await waitFor(() => expect(mutations('/catalog').at(-1)?.body).toEqual({ providerId: 'p2', protocol: 'anthropic' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  expect(mutations('/providers')).toHaveLength(0); expect(mutations('/activate')).toHaveLength(0);
  expect(state.providers[1]).toEqual(original); expect(storedKeys.p2).toBe('claude-key');
});
