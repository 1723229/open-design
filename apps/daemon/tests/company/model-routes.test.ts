import { afterEach, expect, test } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompanyModelSettingsResponse, CompanyUser } from '@open-design/contracts';
import { CompanyModelSettings } from '../../src/company/model-settings.js';
import { registerCompanyModelRoutes } from '../../src/company/model-routes.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const draft = { expectedRevision: 0, name: 'Gateway', baseUrl: 'https://gateway.example', apiKey: 'PRIVATE_KEY', models: ['model-a'] };
async function setup(options: { role?: 'admin' | 'member' | 'anonymous'; enabled?: boolean; available?: boolean; unsupported?: boolean; crash?: boolean; network?: boolean; catalogStatus?: number; empty?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'model-routes-')); roots.push(root);
  const upstream: Array<{ url: string; headers: Headers }> = [];
  const models = new CompanyModelSettings(root, { nativeProbe: async r => ({model:r.model,protocol:r.protocol,status:options.unsupported || options.crash ? 'error' : 'supported',checkedAt:Date.now(),...(r.agentId ? {testedBy:r.agentId} : {}),verification:'file-write'}), fetchImpl: async (url, init) => {
    upstream.push({ url: String(url), headers: new Headers(init?.headers) });
    if (options.network) throw Object.assign(new Error('upstream network failure'), { cause: { code: 'ECONNREFUSED' } });
    if (options.crash) throw new Error('PRIVATE_KEY upstream crash');
    if (String(url).endsWith('/models')) {
      if (options.catalogStatus) return new Response('upstream failure', { status: options.catalogStatus });
      return Response.json({ data: options.empty ? [] : [{ id: 'model-a' }, { id: 'model-b' }] });
    }
    if (!String(url).endsWith('/responses') || options.unsupported) return new Response('PRIVATE_KEY', { status: 404 });
    return new Response('data: {"type":"response.output_item.done","item":{"type":"function_call","name":"nexus_probe","arguments":"{}"}}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const audits: unknown[][] = [];
  const app = express(); app.use(express.json());
  registerCompanyModelRoutes(app, {
    company: { enabled: options.enabled ?? true, getUser: () => options.role === 'anonymous' ? null : ({ id: 'u', username: 'user', role: options.role ?? 'admin', mustChangePassword: false, source: 'local', disabled: false } as CompanyUser), store: { audit: (...args: [string, string, string]) => { audits.push(args); } } },
    models,
    detectAgents: async () => [{ id: 'codex', name: 'Codex', bin: 'codex', available: options.available ?? true, authStatus: 'missing', version: '1.2.3', path: '/private' }, { id: 'claude', name: 'Claude', bin: 'claude', available: true }, { id: 'unexpected', name: 'Other', bin: 'other', available: true }],
  });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/company/models`;
  const request = (suffix = '', body?: unknown, method = 'POST') => fetch(`${base}${suffix}`, body === undefined ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const save = () => request('/providers', draft, 'PUT').then(r => r.json()) as Promise<CompanyModelSettingsResponse>;
  return { request, save, models, audits, upstream };
}

test.each([{ role: 'member' as const, status: 403 }, { role: 'anonymous' as const, status: 401 }, { enabled: false, status: 404 }])('protects every model endpoint: %j', async options => {
  const { request } = await setup(options);
  expect((await request()).status).toBe(options.status);
  for (const [suffix, method] of [['/providers', 'PUT'], ['/test', 'POST'], ['/activate', 'POST'], ['/catalog', 'POST'], ['/providers/example', 'DELETE']]) expect((await request(suffix, draft, method)).status).toBe(options.status);
});

test('returns only safe provider and known agent summaries on reads and writes', async () => {
  const { save, request, audits } = await setup();
  const saved = await save();
  expect(saved.active).toBeNull();
  expect(saved.providers[0]).toMatchObject({ hasApiKey: true, baseUrl: 'https://gateway.example/v1' });
  for (const view of [saved, await request().then(r => r.json()) as CompanyModelSettingsResponse]) {
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('PRIVATE_KEY'); expect(serialized).not.toContain('/private'); expect(serialized).not.toContain('unexpected');
    expect(view.agents).toHaveLength(4);
    expect(view.agents[0]).toMatchObject({ id: 'codex', installed: true, version: '1.2.3' });
  }
  expect(JSON.stringify(audits)).not.toContain('PRIVATE_KEY'); expect(audits[0]).toEqual(['u', 'models.provider.save', saved.providers[0]!.id]);
});

test('requires a fresh compatible test before explicit activation, ignoring CLI OAuth status', async () => {
  const { save, request, models } = await setup();
  const saved = await save(); const providerId = saved.providers[0]!.id;
  const selection = { expectedRevision: saved.revision, providerId, model: 'model-a', agentId: 'codex' };
  expect((await request('/activate', selection)).status).toBe(422);
  const tested = await request('/test', selection).then(r => r.json()) as CompanyModelSettingsResponse;
  expect(tested.active).toBeNull(); expect(tested.agents).toHaveLength(4);
  const incompatible = await request('/activate', { ...selection, expectedRevision: tested.revision, agentId: 'claude' });
  expect(incompatible.status).toBe(422); expect(await incompatible.json()).toMatchObject({ code: 'capability_required' });
  const active = await request('/activate', { ...selection, expectedRevision: tested.revision }).then(r => r.json()) as CompanyModelSettingsResponse;
  expect(active.active).toMatchObject({ agentId: 'codex', model: 'model-a', protocol: 'responses' });
  expect(models.pinActive().providerId).toBe(providerId);
  expect((await request('/providers', draft, 'PUT')).status).toBe(409);
  expect(models.pinActive().providerId).toBe(providerId);
});

test('rejects activation for missing executables after a successful API probe', async () => {
  const { save, request } = await setup({ available: false }); const saved = await save();
  const input = { expectedRevision: saved.revision, providerId: saved.providers[0]!.id, model: 'model-a', agentId: 'codex' };
  const tested = await request('/test', input);
  expect(tested.status).toBe(422);
  expect(await tested.json()).toMatchObject({code:'agent_unavailable'});
  const response = await request('/activate', input);
  expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code: 'agent_unavailable' });
});

test('returns catalog candidates and safe validation/provider errors', async () => {
  const { save, request } = await setup(); const saved = await save();
  expect(await request('/catalog', { providerId: saved.providers[0]!.id }).then(r => r.json())).toEqual({ models: ['model-a', 'model-b'], status: 'ok' });
  const missing = await request('/catalog', { providerId: 'missing' }); expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ code: 'provider_not_found' });
  expect((await request('/test', null)).status).toBe(400);
  const failing = await setup({ crash: true }); const draftSaved = await failing.save();
  const error = await failing.request('/catalog', { providerId: draftSaved.providers[0]!.id });
  expect(error.status).toBe(502); expect(await error.text()).not.toContain('PRIVATE_KEY');
});

test('catalogs an unsaved provider without creating a provider or requiring a model', async () => {
  const { request, models } = await setup();
  const response = await request('/catalog', {
    baseUrl: 'https://gateway.example',
    apiKey: 'PRIVATE_KEY',
    protocol: 'openai',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ models: ['model-a', 'model-b'], status: 'ok' });
  expect(models.view()).toMatchObject({ revision: 0, providers: [], active: null });
});

test('catalogs a saved provider with a blank browser key by reusing the server key', async () => {
  const { request, save, upstream, models } = await setup();
  const saved = await save();
  const response = await request('/catalog', { providerId: saved.providers[0]!.id, protocol: 'openai', apiKey: '' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ models: ['model-a', 'model-b'], status: 'ok' });
  expect(upstream.at(-1)?.headers.get('authorization')).toBe('Bearer PRIVATE_KEY');
  expect(models.view()).toMatchObject({ revision: saved.revision, active: null });
  expect(JSON.stringify(models.view())).not.toContain('PRIVATE_KEY');
});

test.each([
  [401, 'catalog_auth_failed'],
  [403, 'catalog_auth_failed'],
  [404, 'catalog_unsupported'],
  [405, 'catalog_unsupported'],
  [501, 'catalog_unsupported'],
])('classifies provider catalog HTTP %s as %s', async (status, code) => {
  const { request } = await setup({ catalogStatus: status });
  const response = await request('/catalog', { baseUrl: 'https://gateway.example', apiKey: 'PRIVATE_KEY', protocol: 'openai' });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ code });
});

test('discovers an edited saved URL with its server key without persisting the URL', async () => {
  const { request, save, upstream, models } = await setup(); const saved = await save();
  const response = await request('/catalog', { providerId: saved.providers[0]!.id, baseUrl: 'https://edited.example/v1', apiKey: '', protocol: 'openai' });
  expect(response.status).toBe(200);
  expect(upstream.at(-1)?.url).toBe('https://edited.example/v1/models');
  expect(upstream.at(-1)?.headers.get('authorization')).toBe('Bearer PRIVATE_KEY');
  expect(models.view()).toMatchObject({ revision: saved.revision, providers: saved.providers, active: saved.active });
});

test('classifies a provider catalog with no models as an explicit empty result', async () => {
  const { request } = await setup({ empty: true });
  const response = await request('/catalog', { baseUrl: 'https://gateway.example', apiKey: 'PRIVATE_KEY', protocol: 'openai' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ models: [], status: 'empty' });
});

test('rejects incomplete unsaved catalog parameters without contacting a provider', async () => {
  const { request } = await setup();
  const response = await request('/catalog', { baseUrl: 'https://gateway.example', protocol: 'openai' });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'catalog_parameters_incomplete' });
});

test('classifies provider network failures separately from authentication and unsupported catalogs', async () => {
  const { request } = await setup({ network: true });
  const response = await request('/catalog', { baseUrl: 'https://gateway.example', apiKey: 'PRIVATE_KEY', protocol: 'openai' });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ code: 'catalog_network_error' });
});

test('deletes unused provider with revision checks and audits its ID', async () => {
 const {save,request,audits}=await setup();const v=await save();const id=v.providers[0]!.id;
 expect((await request(`/providers/${id}`,{expectedRevision:0},'DELETE')).status).toBe(409);
 const response=await request(`/providers/${id}`,{expectedRevision:v.revision},'DELETE');
 expect(response.status).toBe(200);expect((await response.json() as CompanyModelSettingsResponse).providers).toEqual([]);expect(audits.at(-1)).toEqual(['u','models.provider.delete',id]);
});
