import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProbeRequest } from '../../src/company/model-probe.js';
import { CompanyModelSettings, COMPANY_MODEL_AGENTS } from '../../src/company/model-settings.js';

const roots: string[] = [];
function root() { const p = mkdtempSync(path.join(tmpdir(), 'model-settings-')); roots.push(p); return p; }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const nativeSuccess = async (r: ProbeRequest) => ({model:r.model,protocol:r.protocol,status:'supported' as const,checkedAt:(r.now ?? Date.now)(),...(r.agentId ? {testedBy:r.agentId} : {}),verification:'file-write' as const});
const draft = { expectedRevision: 0, name: 'Gateway', baseUrl: 'https://gateway.example/v1///', apiKey: 'private-original', models: [' model-a ', 'model-a', 'model-b'] };
const agents = COMPANY_MODEL_AGENTS.map(a => ({ ...a, installed: true }));
const supportedFetch: typeof fetch = async (_url, init) => {
  const b = JSON.parse(String(init?.body));
  const event = 'input' in b
    ? { type: 'response.output_item.done', item: { type: 'function_call', name: 'nexus_probe', arguments: '{}' } }
    : 'max_tokens' in b
      ? { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'nexus_probe', input: {} } }
      : { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'nexus_probe', arguments: '{}' } }] } }] };
  const terminal = 'input' in b ? [{ type: 'response.completed' }]
    : 'max_tokens' in b ? [{ type: 'content_block_stop', index: 0 }, { type: 'message_stop' }]
      : [{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
  const end = terminal.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(`data: ${JSON.stringify(event)}\n\n${end}`, { headers: { 'content-type': 'text/event-stream' } });
};

describe('company model settings', () => {
  it('shows the effective provider revision URL while a different URL is only a saved draft', async () => {
    const p = root(); const s = new CompanyModelSettings(p, { nativeProbe: nativeSuccess, fetchImpl: supportedFetch });
    let view = s.saveProvider(draft); const providerId = view.providers[0]!.id;
    view = await s.testProvider({agentId:'codex', expectedRevision: view.revision, providerId, model: 'model-a' });
    view = s.activate({ expectedRevision: view.revision, providerId, model: 'model-a', agentId: 'codex' }, agents);
    expect(view.active?.baseUrl).toBe('https://gateway.example/v1');
    view = s.saveProvider({ ...draft, id: providerId, expectedRevision: view.revision, baseUrl: 'https://draft.example/v1' });
    expect(view.providers[0]!.baseUrl).toBe('https://draft.example/v1');
    expect(view.active?.baseUrl).toBe('https://gateway.example/v1');
    expect(new CompanyModelSettings(p).view().active?.baseUrl).toBe('https://gateway.example/v1');
    expect(JSON.stringify(view.active)).not.toContain('private-original');
  });

  it.each(['responses', 'anthropic-messages'] as const)('activates and pins verified OpenCode %s without allowing it for incompatible agents', async protocol => {
    const p = root(); const s = new CompanyModelSettings(p, { nativeProbe: nativeSuccess, fetchImpl: supportedFetch });
    let view = s.saveProvider(draft); const providerId = view.providers[0]!.id;
    view = await s.testProvider({agentId:'opencode',protocol, expectedRevision: view.revision, providerId, model: 'model-a' });
    const selected = s.activate({ expectedRevision: view.revision, providerId, model: 'model-a', agentId: 'opencode', protocol }, agents);
    expect(selected.active).toMatchObject({ agentId: 'opencode', protocol });
    const pinned = s.pinActive();
    expect(new CompanyModelSettings(p).resolve(pinned)).toMatchObject({ protocol, apiKey: 'private-original' });
    expect(() => s.activate({ expectedRevision: selected.revision, providerId, model: 'model-a', agentId: protocol === 'responses' ? 'claude' : 'codex', protocol }, agents)).toThrow();
    expect(s.pinActive()).toEqual(pinned);
  });

  it('normalizes and redacts saved secrets while omitted keys survive restart', () => {
    const p = root(); const s = new CompanyModelSettings(p);
    const saved = s.saveProvider(draft);
    expect(saved.providers[0]).toMatchObject({ baseUrl: 'https://gateway.example/v1', models: ['model-a', 'model-b'], hasApiKey: true });
    expect(JSON.stringify(saved)).not.toContain('private-original');
    const id = saved.providers[0]!.id;
    const { apiKey: _key, ...withoutKey } = draft;
    const next = new CompanyModelSettings(p).saveProvider({ ...withoutKey, id, expectedRevision: 1 });
    expect(next.revision).toBe(2);
    expect(new CompanyModelSettings(p).resolve({ agentId: 'codex', providerId: id, providerRevision: 2, model: 'model-a', protocol: 'responses' }).apiKey).toBe('private-original');
  });
  it.each(['ftp://example.com', 'https://u:password@example.com', 'https://example.com?key=secret', 'https://example.com/#x', 'https://example.com?', 'https://example.com/#'])('rejects unsafe URL %s', baseUrl => {
    expect(() => new CompanyModelSettings(root()).saveProvider({ ...draft, baseUrl })).toThrow();
  });
  it('rejects empty keys and stale cross-instance writes without changing state', () => {
    const p = root(); const a = new CompanyModelSettings(p); const b = new CompanyModelSettings(p);
    expect(() => a.saveProvider({ ...draft, apiKey: '' })).toThrow();
    a.saveProvider(draft);
    expect(() => b.saveProvider(draft)).toThrow(expect.objectContaining({ status: 409 }));
    expect(a.view().revision).toBe(1);
  });
  it('retains or clears the original token limit while queued routes keep their revision', () => {
    const p = root(); const retained: ReturnType<CompanyModelSettings['pinActive']>[] = [];
    const s = new CompanyModelSettings(p, { retainedRoutes: () => retained });
    let v = s.saveProvider({ ...draft, maxTokens: 12000 }); const id = v.providers[0]!.id;
    const route = { agentId: 'codex' as const, protocol: 'responses' as const, providerId: id, providerRevision: 1, model: 'model-a' };
    retained.push(route);
    expect(v.providers[0]!.maxTokens).toBe(12000);
    v = s.saveProvider({ ...draft, id, expectedRevision: v.revision });
    expect(v.providers[0]!.maxTokens).toBe(12000);
    v = s.saveProvider({ ...draft, id, expectedRevision: v.revision, maxTokens: null });
    expect(v.providers[0]!.maxTokens).toBeUndefined();
    const restarted = new CompanyModelSettings(p);
    expect(restarted.resolve(route).maxTokens).toBe(12000);
    expect(restarted.resolve({ ...route, providerRevision: 3 }).maxTokens).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain('private-original');
  });
  it.each([0, 1023, 200001, 1024.5, '12000', true])('rejects an invalid token limit %s without saving', maxTokens => {
    const s = new CompanyModelSettings(root());
    expect(() => s.saveProvider({ ...draft, maxTokens } as Parameters<CompanyModelSettings['saveProvider']>[0])).toThrow();
    expect(s.view().revision).toBe(0);
  });
  it.each([1024, 200000])('accepts the original token input boundary %s', maxTokens => {
    expect(new CompanyModelSettings(root()).saveProvider({ ...draft, maxTokens }).providers[0]!.maxTokens).toBe(maxTokens);
  });
  it('migrates once and keeps the original active secret across edits/restart', () => {
    const p = root(); const legacy = { agentId: 'codex', agentModels: { codex: { model: 'legacy-model' } }, agentCliEnv: { codex: { OPENAI_BASE_URL: 'https://legacy.example/v1', CODEX_API_KEY: 'old-key' } } };
    const s = new CompanyModelSettings(p, { legacy }); const active = s.pinActive();
    expect(s.view().active?.verifiedAt).toBeNull();
    s.saveProvider({ ...draft, id: active.providerId, expectedRevision: s.view().revision });
    const restarted = new CompanyModelSettings(p, { legacy: { ...legacy, agentId: 'claude' } });
    expect(restarted.pinActive()).toEqual(active);
    expect(restarted.resolve(active).apiKey).toBe('old-key');
    expect(legacy.agentCliEnv.codex.CODEX_API_KEY).toBe('old-key');
  });
  it.each([
    ['opencode', 'openai/vendor/model-a', 'vendor/model-a', { OPENAI_BASE_URL: 'https://legacy.example/v1', OPENAI_API_KEY: 'old-key' }],
    ['deepseek-harness', 'deepseek/model-a', 'model-a', { DEEPSEEK_BASE_URL: 'https://legacy.example/v1', DEEPSEEK_API_KEY: 'old-key' }],
    ['codex', 'vendor/model-a', 'vendor/model-a', { OPENAI_BASE_URL: 'https://legacy.example/v1', CODEX_API_KEY: 'old-key' }],
    ['claude', 'vendor/model-a', 'vendor/model-a', { ANTHROPIC_BASE_URL: 'https://legacy.example/v1', ANTHROPIC_API_KEY: 'old-key' }],
  ] as const)('preserves the upstream model when migrating %s and restarting', (agentId, model, upstreamModel, env) => {
    const p = root(); const legacy = { agentId, agentModels: { [agentId]: { model } }, agentCliEnv: { [agentId]: env } };
    const original = structuredClone(legacy);
    const s = new CompanyModelSettings(p, { legacy }); const active = s.pinActive();
    expect(active.model).toBe(upstreamModel);
    expect(s.resolve(active).model).toBe(upstreamModel);
    expect(s.view().providers[0]?.models).toEqual([upstreamModel]);
    const restarted = new CompanyModelSettings(p, { legacy: { ...legacy, agentId: 'other' } });
    expect(restarted.pinActive()).toEqual(active);
    expect(restarted.resolve(active)).toMatchObject({ model: upstreamModel, apiKey: 'old-key' });
    expect(legacy).toEqual(original);
  });
  it.each([
    ['codex', 'model-a', { OPENAI_API_KEY: 'old-key' }, 'https://api.openai.com/v1'],
    ['opencode', 'openai/model-a', { OPENAI_API_KEY: 'old-key' }, 'https://api.openai.com/v1'],
    ['claude', 'model-a', { ANTHROPIC_API_KEY: 'old-key' }, 'https://api.anthropic.com/v1'],
    ['deepseek-harness', 'deepseek/model-a', { DEEPSEEK_API_KEY: 'old-key' }, 'https://api.deepseek.com/v1'],
  ] as const)('migrates key/model-only %s using its official endpoint once', (agentId, model, env, baseUrl) => {
    const p = root(); const legacy = { agentId, agentModels: { [agentId]: { model } }, agentCliEnv: { [agentId]: env } };
    const original = structuredClone(legacy);
    const s = new CompanyModelSettings(p, { legacy }); const route = s.pinActive();
    expect(s.resolve(route)).toMatchObject({ baseUrl, model: 'model-a', apiKey: 'old-key' });
    const restarted = new CompanyModelSettings(p, { legacy: { agentId: 'other' } });
    expect(restarted.pinActive()).toEqual(route);
    expect(restarted.resolve(route).baseUrl).toBe(baseUrl);
    expect(legacy).toEqual(original);
  });
  it.each([
    { agentId: 'codex', agentModels: { codex: { model: 'model-a' } } },
    { agentId: 'codex', agentCliEnv: { codex: { OPENAI_API_KEY: 'key' } } },
  ])('does not migrate missing legacy keys or models', legacy => {
    expect(new CompanyModelSettings(root(), { legacy }).view()).toMatchObject({ providers: [], active: null });
  });
  it('preserves slashes in manually saved native model IDs', () => {
    const p = root(); const s = new CompanyModelSettings(p);
    const saved = s.saveProvider({ ...draft, models: ['vendor/model-a'] });
    expect(new CompanyModelSettings(p).resolve({ agentId: 'opencode', protocol: 'chat-completions', providerId: saved.providers[0]!.id, providerRevision: 1, model: 'vendor/model-a' }).model).toBe('vendor/model-a');
  });
  it('requires installed compatible fresh tested models and retains unfinished routes after replacement', async () => {
    const p = root(); let now = 1000; const retained: ReturnType<CompanyModelSettings['pinActive']>[] = [];
    const options = { nativeProbe: nativeSuccess, fetchImpl: supportedFetch, now: () => now, retainedRoutes: () => retained };
    const s = new CompanyModelSettings(p, options); let v = s.saveProvider(draft); const id = v.providers[0]!.id;
    const activate = () => s.activate({ expectedRevision: s.view().revision, providerId: id, model: 'model-a', agentId: 'codex' }, agents);
    expect(activate).toThrow();
    v = await s.testProvider({agentId:'codex', expectedRevision: v.revision, providerId: id, model: 'model-a' });
    expect(() => s.activate({ expectedRevision: v.revision, providerId: id, model: 'model-b', agentId: 'codex' }, agents)).toThrow();
    expect(() => s.activate({ expectedRevision: v.revision, providerId: id, model: 'model-a', agentId: 'codex' }, [])).toThrow();
    activate(); const original = s.pinActive(); retained.push(original);
    v = s.saveProvider({ ...draft, id, expectedRevision: s.view().revision, apiKey: 'replacement' });
    expect(s.pinActive()).toEqual(original); expect(activate).toThrow();
    v = await s.testProvider({agentId:'codex', expectedRevision: v.revision, providerId: id, model: 'model-a' }); activate();
    expect(new CompanyModelSettings(p, options).resolve(original).apiKey).toBe('private-original');
    retained.splice(0); s.saveProvider({ ...draft, id, expectedRevision: s.view().revision, apiKey: 'third' });
    expect(readFileSync(path.join(p, 'company-models.json'), 'utf8')).not.toContain('private-original');
    now += 24 * 60 * 60 * 1000; expect(activate).toThrow();
  });
  it('does not persist a probe result when another write changes the provider', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const s = new CompanyModelSettings(root(), { fetchImpl: async (...args) => { await gate; return supportedFetch(...args); } });
    const v = s.saveProvider(draft); const id = v.providers[0]!.id;
    const pending = s.testProvider({agentId:'codex', expectedRevision: v.revision, providerId: id, model: 'model-a' });
    s.saveProvider({ ...draft, id, expectedRevision: v.revision, apiKey: 'new' }); release();
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(s.view().providers[0]!.capabilities).toEqual([]);
  });
  it('leaves incomplete legacy configuration manageable', () => {
    expect(new CompanyModelSettings(root(), { legacy: { agentId: 'codex' } }).view()).toMatchObject({ providers: [], active: null });
  });
  it('normalizes bare origins to v1 while preserving custom path prefixes', () => {
    for (const [input, want] of [['https://example.com/', 'https://example.com/v1'], ['https://example.com', 'https://example.com/v1'], ['https://example.com/api/v1/', 'https://example.com/api/v1']]) {
      expect(new CompanyModelSettings(root()).saveProvider({ ...draft, baseUrl: input! }).providers[0]?.baseUrl).toBe(want);
    }
    const migrated = new CompanyModelSettings(root(), { legacy: { agentId: 'claude', agentModels: { claude: { model: 'sonnet' } }, agentCliEnv: { claude: { ANTHROPIC_BASE_URL: 'https://anthropic.example/', ANTHROPIC_AUTH_TOKEN: 'key' } } } });
    expect(migrated.resolve(migrated.pinActive()).baseUrl).toBe('https://anthropic.example/v1');
  });
  it('keeps the effective route when capabilities fail, expire, or target an incompatible agent', async () => {
    let now = 1000; let fail = false;
    const s = new CompanyModelSettings(root(), { now: () => now, nativeProbe: async r => ({...await nativeSuccess(r), status: fail ? 'error' : 'supported'}), fetchImpl: (...args) => fail ? Promise.resolve(new Response('upstream-private', { status: 401 })) : supportedFetch(...args) });
    let v = s.saveProvider(draft); const id = v.providers[0]!.id;
    v = await s.testProvider({agentId:'codex', expectedRevision: v.revision, providerId: id, model: 'model-a' });
    v = s.activate({ expectedRevision: v.revision, agentId: 'codex', providerId: id, model: 'model-a' }, agents);
    const active = s.pinActive();
    now += 24 * 60 * 60 * 1000;
    expect(() => s.activate({ expectedRevision: v.revision, agentId: 'codex', providerId: id, model: 'model-a' }, agents)).toThrow();
    fail = true;
    v = await s.testProvider({agentId:'codex', expectedRevision: v.revision, providerId: id, model: 'model-a' });
    expect(v.providers[0]?.capabilities.every(c => c.status === 'error')).toBe(true);
    expect(() => s.activate({ expectedRevision: v.revision, agentId: 'claude', providerId: id, model: 'model-a' }, agents)).toThrow();
    expect(s.pinActive()).toEqual(active);
  });
});

it('tests selected native Messages and pins the private revision during async work', async () => {
  let resume!: () => void;
  const gate = new Promise<void>(r => { resume = r; });
  const seen: unknown[] = [];
  const nativeProbe = async (request: { model: string; protocol: string; apiKey: string; baseUrl: string }) => {
    seen.push({...request}); await gate;
    return {model:request.model,protocol:'anthropic-messages' as const,status:'supported' as const,checkedAt:100,testedBy:'claude' as const,verification:'file-write' as const};
  };
  const store = new CompanyModelSettings(root(), {nativeProbe, fetchImpl:async () => new Response('', {status:400})});
  const saved = store.saveProvider(draft); const id = saved.providers[0]!.id;
  const testing = store.testProvider({agentId:'claude',expectedRevision:1,providerId:id,model:'model-a'});
  await Promise.resolve(); await Promise.resolve();
  store.saveProvider({...draft,id,expectedRevision:1,apiKey:'new-private'});
  resume();
  await expect(testing).rejects.toMatchObject({status:409});
  expect(seen).toEqual([expect.objectContaining({model:'model-a',protocol:'anthropic-messages',apiKey:'private-original',baseUrl:'https://gateway.example/v1'})]);
  expect(store.view().providers[0]!.capabilities).toEqual([]);
});

it('runs selected native verification even when generic discovery succeeds', async () => {
  let calls = 0;
  const nativeProbe = async (request: {model:string}) => { calls++; return {model:request.model,protocol:'anthropic-messages' as const,status:'supported' as const,checkedAt:100,testedBy:'claude' as const,verification:'file-write' as const}; };
  for (const successful of [false,true]) {
    const store = new CompanyModelSettings(root(), {nativeProbe, fetchImpl:successful ? supportedFetch : async () => new Response('',{status:400})});
    const saved = store.saveProvider(draft);
    const result = await store.testProvider({agentId:'claude',expectedRevision:1,providerId:saved.providers[0]!.id,model:'model-a'});
    expect(result.providers[0]!.capabilities.filter(c=>c.status==='supported').map(c=>c.protocol).sort()).toEqual(successful ? ['anthropic-messages','anthropic-messages','chat-completions','responses'] : ['anthropic-messages']);
    expect(result.active).toBeNull();
  }
  expect(calls).toBe(2);
});

it('does not reuse Claude-only native proof to activate OpenCode Messages', async () => {
  const store = new CompanyModelSettings(root(), { now: () => 100,
    nativeProbe: async request => ({ model: request.model, protocol: request.protocol, status: 'supported', checkedAt: 100, testedBy:'claude', verification:'file-write' }),
    fetchImpl: async () => new Response('', { status: 400 }),
  });
  let view = store.saveProvider(draft); const providerId = view.providers[0]!.id;
  view = await store.testProvider({agentId:'claude', expectedRevision: view.revision, providerId, model: 'model-a' });
  expect(() => store.activate({ expectedRevision: view.revision, providerId, model: 'model-a', agentId: 'opencode', protocol: 'anthropic-messages' }, agents)).toThrow();
  expect(store.activate({ expectedRevision: view.revision, providerId, model: 'model-a', agentId: 'claude' }, agents).active?.agentId).toBe('claude');
});

it('keeps the generic safe diagnostic if native proof fails or cannot run', async () => {
  for (const nativeProbe of [async()=>{throw new Error('private-original');},async()=>({model:'model-a',protocol:'anthropic-messages' as const,status:'unsupported' as const,checkedAt:100})]) {
    const store = new CompanyModelSettings(root(),{nativeProbe,fetchImpl:async()=>new Response('',{status:400})});
    const saved=store.saveProvider(draft);
    const tested=await store.testProvider({agentId:'claude',expectedRevision:1,providerId:saved.providers[0]!.id,model:'model-a'});
    expect(tested.providers[0]!.capabilities.every(c=>c.status==='error' && Boolean(c.message))).toBe(true);
    expect(JSON.stringify(tested)).not.toContain('private-original');
  }
});

it('preserves evidence on name-only edits and persists the original form protocol', async () => {
 const s=new CompanyModelSettings(root(),{nativeProbe:nativeSuccess,fetchImpl:supportedFetch});
 let v=s.saveProvider({...draft,apiProtocol:'anthropic'});const id=v.providers[0]!.id;
 v=await s.testProvider({agentId:'codex',expectedRevision:v.revision,providerId:id,model:'model-a'});const evidence=v.providers[0]!.capabilities;
 v=s.saveProvider({...draft,id,name:'Renamed',expectedRevision:v.revision});
 expect(v.providers[0]).toMatchObject({name:'Renamed',apiProtocol:'anthropic',capabilities:evidence});
});
it('rejects deleting active and retained routes then removes only the unused provider', async () => {
 const retained: ReturnType<CompanyModelSettings['pinActive']>[]=[];
 const s=new CompanyModelSettings(root(),{nativeProbe:nativeSuccess,fetchImpl:supportedFetch,retainedRoutes:()=>retained});
 let v=s.saveProvider(draft);const id=v.providers[0]!.id;
 v=await s.testProvider({agentId:'codex',expectedRevision:v.revision,providerId:id,model:'model-a'});
 v=s.activate({expectedRevision:v.revision,providerId:id,model:'model-a',agentId:'codex'},agents);retained.push(s.pinActive());
 expect(()=>s.deleteProvider(id,{expectedRevision:v.revision})).toThrow(expect.objectContaining({status:409}));
 v=s.saveProvider({...draft,expectedRevision:v.revision,apiKey:'second'});const other=v.providers[1]!.id;
 v=await s.testProvider({agentId:'codex',expectedRevision:v.revision,providerId:other,model:'model-a'});
 v=s.activate({expectedRevision:v.revision,providerId:other,model:'model-a',agentId:'codex'},agents);
 expect(()=>s.deleteProvider(id,{expectedRevision:v.revision})).toThrow(expect.objectContaining({status:409}));
 retained.length=0;expect(()=>s.deleteProvider(id,{expectedRevision:0})).toThrow(expect.objectContaining({status:409}));
 v=s.deleteProvider(id,{expectedRevision:v.revision});expect(v.providers.map(p=>p.id)).toEqual([other]);expect(s.resolve(s.pinActive()).apiKey).toBe('second');
});
