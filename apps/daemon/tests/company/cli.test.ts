import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyCliFetch, createCompanyTaskFetch, runCompanyCli } from '../../src/company/cli.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function endpoint(handler: express.Express) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('company CLI credentials', () => {
  it('uses the shared model management endpoints and file input without exposing keys', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-model-cli-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'provider.json');
    writeFileSync(file, JSON.stringify({ expectedRevision: 1, name: 'Provider', baseUrl: 'https://api.example/v1', apiKey: 'PRIVATE', models: ['m'] }));
    const requests: Array<{path:string;body:unknown}> = [];
    const app = express(); app.use(express.json());
    app.get('/api/company/session', (_req,res) => res.json({enabled:true,user:{id:'admin'},csrfToken:'csrf'}));
    app.get('/api/company/models', (_req,res) => res.json({providers:[],active:null}));
    app.delete('/api/company/models/providers/p1', (req,res) => { requests.push({path:req.path,body:req.body}); expect(req.get('x-csrf-token')).toBe('csrf'); res.json({providers:[]}); });
    app.put('/api/company/models/providers', (req,res) => { requests.push({path:req.path,body:req.body}); res.json({providers:[{hasApiKey:true}]}); });
    const daemonUrl = await endpoint(app); const output: string[] = [];
    const options = { env: { OD_COMPANY_SESSION: 'a'.repeat(43) }, stdout: (v:string) => output.push(v) };
    expect(await runCompanyCli(['models','list','--daemon-url',daemonUrl,'--json'],options)).toBe(0);
    expect(await runCompanyCli(['models','provider-save','--prompt-file',file,'--daemon-url',daemonUrl,'--json'],options)).toBe(0);
    expect(requests[0]).toMatchObject({path:'/api/company/models/providers',body:{apiKey:'PRIVATE'}});
    writeFileSync(file, JSON.stringify({providerId:'p1',expectedRevision:2}));
    expect(await runCompanyCli(['models','provider-delete','--prompt-file',file,'--daemon-url',daemonUrl,'--json'],options)).toBe(0);
    expect(requests[1]).toMatchObject({path:'/api/company/models/providers/p1',body:{expectedRevision:2}});
    app.post('/api/company/models/test', (req,res)=>{requests.push({path:req.path,body:req.body});res.json({revision:3});});
    writeFileSync(file, JSON.stringify({providerId:'p1',expectedRevision:2,model:'m',agentId:'opencode',protocol:'responses'}));
    expect(await runCompanyCli(['models','test','--prompt-file',file,'--daemon-url',daemonUrl,'--json'],options)).toBe(0);
    expect(requests[2]).toMatchObject({path:'/api/company/models/test',body:{agentId:'opencode',protocol:'responses',model:'m'}});
    expect(output.join('')).not.toContain('PRIVATE');
  });
  it('uses a task bearer through the proxy API prefix without requesting an interactive session', async () => {
    const app = express();
    let sessionRequests = 0;
    app.get('/od/api/company/session', (_req, res) => { sessionRequests += 1; res.sendStatus(403); });
    app.post('/od/api/projects/p1/files', (req, res) => res.json({ authorization: req.get('authorization'), csrf: req.get('x-csrf-token') ?? null, cookie: req.get('cookie') ?? null }));
    app.get('/control/leases', (req, res) => res.json({ authorization: req.get('authorization') ?? null }));
    const origin = await endpoint(app);
    const client = createCompanyTaskFetch({ daemonUrl: `${origin}/od`, token: 't'.repeat(43) });
    expect(await client(`${origin}/od/api/projects/p1/files`, { method: 'POST' }).then((r) => r.json())).toEqual({ authorization: `Bearer ${'t'.repeat(43)}`, csrf: null, cookie: null });
    expect(await client(`${origin}/control/leases`).then((r) => r.json())).toEqual({ authorization: null });
    expect(sessionRequests).toBe(0);
  });

  it('adds cookie and lazily obtains CSRF only for the chosen daemon origin', async () => {
    const app = express();
    let sessions = 0;
    app.get('/api/company/session', (req, res) => {
      if (req.headers.cookie !== `od_company_session=${'a'.repeat(43)}`) return res.sendStatus(401);
      sessions += 1;
      res.json({ enabled: true, user: { id: 'user' }, csrfToken: 'csrf-for-cli' });
    });
    app.post('/api/projects', (req, res) => res.json({ cookie: req.get('cookie'), csrf: req.get('x-csrf-token'), origin: req.get('origin') }));
    const daemonUrl = await endpoint(app);
    const outsider = express();
    outsider.get('/api/projects', (req, res) => res.json({ cookie: req.get('cookie') ?? null }));
    const otherOrigin = await endpoint(outsider);
    const client = createCompanyCliFetch({ daemonUrl, token: 'a'.repeat(43) });
    const first = await client(`${daemonUrl}/api/projects`, { method: 'POST' }).then((r) => r.json());
    expect(first).toEqual({ cookie: `od_company_session=${'a'.repeat(43)}`, csrf: 'csrf-for-cli', origin: daemonUrl });
    await client(`${daemonUrl}/api/projects`, { method: 'POST' });
    expect(sessions).toBe(1);
    expect(await client(`${otherOrigin}/api/projects`).then((r) => r.json())).toEqual({ cookie: null });
  });

  it('logs in through the HTTP endpoint and writes only an explicitly requested session file', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-company-cli-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const secretFile = path.join(root, 'password');
    const sessionFile = path.join(root, 'session.json');
    writeFileSync(secretFile, 'password-from-file\n');
    const app = express();
    app.use(express.json());
    app.post('/api/company/auth/login', (req, res) => {
      if (req.body.username !== 'alice' || req.body.password !== 'password-from-file') return res.sendStatus(401);
      res.setHeader('set-cookie', `od_company_session=${'b'.repeat(43)}; HttpOnly; SameSite=Lax`);
      res.json({ enabled: true, user: { id: 'u1', username: 'alice' }, csrfToken: 'csrf' });
    });
    const daemonUrl = await endpoint(app);
    const output: string[] = [];
    expect(await runCompanyCli(['login', '--username', 'alice', '--password-file', secretFile, '--session-file', sessionFile, '--daemon-url', daemonUrl, '--json'], { stdout: (value) => output.push(value) })).toBe(0);
    expect(JSON.parse(readFileSync(sessionFile, 'utf8'))).toEqual({ daemonOrigin: daemonUrl, token: 'b'.repeat(43) });
    expect(output.join('')).not.toContain('password-from-file');
    expect(output.join('')).not.toContain('b'.repeat(43));
  });
});
