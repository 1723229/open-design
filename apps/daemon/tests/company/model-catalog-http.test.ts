import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeCompany } from '../../src/company/routes.js';
import { CompanyModelSettings } from '../../src/company/model-settings.js';
import { registerCompanyModelRoutes } from '../../src/company/model-routes.js';
import { companyTestDatabase } from './database.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'model-catalog-http-'));
  const database = companyTestDatabase();
  cleanups.push(() => { database.close(); rmSync(dataRoot, { recursive: true, force: true }); });
  const origin = 'http://catalog.test';
  const company = await initializeCompany({ database, dataRoot, config: {
    enabled: true, publicOrigin: origin, auth: { mode: 'local' },
    presentation: { showAgentIdentity: false, hiddenSettingsSections: [] },
  } });
  const admin = company.store.findUser('admin')!;
  company.store.changePassword(admin.id, 'fixture-admin-password');
  const member = company.store.createLocalUser('fixture-member', 'fixture-member-password', 'member', admin.id);
  company.store.changePassword(member.id, 'fixture-member-password');
  let contacts = 0;
  const key = 'fixture-server-only-secret';
  const upstream = await listen(createServer((req, res) => {
    contacts++;
    res.setHeader('content-type', 'application/json');
    if (req.url !== '/v1/models' || req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401); res.end(JSON.stringify({ error: { message: key } })); return;
    }
    res.end(JSON.stringify({ data: [{ id: 'catalog-model' }] }));
  }));
  const models = new CompanyModelSettings(dataRoot);
  const app = express(); app.use(express.json()); app.use(company.middleware); app.use(company.router);
  registerCompanyModelRoutes(app, { company, models, detectAgents: async () => [] });
  const base = await listen(createServer(app));
  async function login(username: string, password: string) {
    const response = await fetch(`${base}/api/company/auth/login`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { csrfToken: string };
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, origin, 'x-csrf-token': body.csrfToken, 'content-type': 'application/json' };
  }
  const headers = await login('admin', 'fixture-admin-password');
  const memberHeaders = await login('fixture-member', 'fixture-member-password');
  const draft = { baseUrl: upstream, apiKey: key, protocol: 'openai' };
  const catalog = (body: unknown, requestHeaders: Record<string, string> = headers) => fetch(`${base}/api/company/models/catalog`, {
    method: 'POST', headers: requestHeaders, body: JSON.stringify(body),
  });
  return { dataRoot, base, headers, memberHeaders, models, key, draft, catalog, contacts: () => contacts };
}

it('enforces real administrator sessions and CSRF before contacting a draft model catalog', async () => {
  const f = await fixture();
  expect((await f.catalog(f.draft, { 'content-type': 'application/json' })).status).toBe(401);
  expect((await f.catalog(f.draft, f.memberHeaders)).status).toBe(403);
  expect((await f.catalog(f.draft, { ...f.headers, 'x-csrf-token': '' })).status).toBe(403);
  expect((await f.catalog(f.draft, { ...f.headers, origin: 'http://other.test' })).status).toBe(403);
  expect(f.contacts()).toBe(0);
  const before = readFileSync(path.join(f.dataRoot, 'company-models.json'), 'utf8');
  const response = await f.catalog(f.draft);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ models: ['catalog-model'], status: 'ok' });
  expect(f.contacts()).toBe(1);
  expect(readFileSync(path.join(f.dataRoot, 'company-models.json'), 'utf8')).toBe(before);
  expect(f.models.view()).toMatchObject({ revision: 0, providers: [], active: null });
});

it('uses the saved server key when the catalog browser key is blank without changing its revision', async () => {
  const f = await fixture();
  const saved = f.models.saveProvider({ expectedRevision: 0, name: 'Fixture', baseUrl: f.draft.baseUrl, apiKey: f.key, models: ['manual-model'] });
  const before = readFileSync(path.join(f.dataRoot, 'company-models.json'), 'utf8');
  const response = await f.catalog({ providerId: saved.providers[0]!.id, apiKey: '', protocol: 'openai' });
  expect(response.status).toBe(200);
  const result = await response.text();
  expect(JSON.parse(result)).toEqual({ models: ['catalog-model'], status: 'ok' });
  expect(result).not.toContain(f.key);
  expect(f.contacts()).toBe(1);
  expect(readFileSync(path.join(f.dataRoot, 'company-models.json'), 'utf8')).toBe(before);
  const settings = await fetch(`${f.base}/api/company/models`, { headers: f.headers }).then(r => r.text());
  expect(settings).not.toContain(f.key);
  expect(JSON.parse(settings)).toMatchObject({ revision: saved.revision, active: null });
});

it('distinguishes a real upstream key rejection from a blocked private endpoint without leaking keys', async () => {
  const f = await fixture();
  const rejected = await f.catalog({ ...f.draft, apiKey: 'invalid-fixture-key' });
  expect(rejected.status).toBe(502);
  const error = await rejected.text();
  expect(JSON.parse(error)).toMatchObject({ code: 'catalog_auth_failed' });
  expect(error).not.toContain(f.key); expect(error).not.toContain('invalid-fixture-key');
  const blocked = await f.catalog({ ...f.draft, baseUrl: 'http://169.254.169.254/v1' });
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toMatchObject({ code: 'catalog_invalid_url' });
  expect(f.contacts()).toBe(1);
  expect(f.models.view()).toMatchObject({ revision: 0, providers: [], active: null });
});

it('rejects missing connection parameters and invalid URLs before making any upstream request', async () => {
  const f = await fixture();
  for (const body of [{ ...f.draft, apiKey: '' }, { ...f.draft, baseUrl: '' }, { ...f.draft, protocol: undefined }]) {
    const response = await f.catalog(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'catalog_parameters_incomplete' });
  }
  for (const baseUrl of ['file:///tmp/provider', 'https://user:password@example.test/v1', 'https://example.test/v1?key=secret']) {
    const response = await f.catalog({ ...f.draft, baseUrl });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_url' });
  }
  expect(f.contacts()).toBe(0);
});
