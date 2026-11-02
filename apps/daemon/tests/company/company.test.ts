import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeCompany, type CompanyRuntime } from '../../src/company/routes.js';
import { loadCompanyConfig, type CompanyConfig } from '../../src/company/config.js';
import { createLdapDirectory, type CompanyLdap } from '../../src/company/auth.js';
import type { CompanySessionResponse } from '@open-design/contracts';
import { companyTestDatabase } from './database.js';
import { installCompanyHttpPolicy } from '../../src/company/http-policy.js';

const resources: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of resources.splice(0).reverse()) await cleanup(); });

function fixture() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'od-company-'));
  resources.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const database = companyTestDatabase();
  resources.push(() => { database.close(); });
  return { dataRoot, database };
}

function member(runtime: CompanyRuntime, username: string) {
  const id = `test-user-${username}`;
  runtime.store.database.prepare("INSERT INTO company_users (id,username,source,role,created_at) VALUES (?,?,'local','member',0)").run(id, username);
  return runtime.store.getUser(id)!;
}

const config: CompanyConfig = {
  enabled: true, publicOrigin: 'http://company.test', auth: { mode: 'local' },
  presentation: { showAgentIdentity: false, hiddenSettingsSections: ['labs', 'integrations'] },
};

async function start(runtime: CompanyRuntime) {
  const app = express();
  app.use(express.json());
  app.use(runtime.middleware);
  app.use(runtime.router);
  app.get('/api/projects/:id/events', (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.flushHeaders();
    res.write('data: opened\n\n');
  });
  app.post('/api/tools/design-systems/read', (req, res) => res.json({ authorization: req.get('authorization') }));
  app.all('/{*path}', (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  resources.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

async function login(base: string, username: string, password: string) {
  const response = await fetch(`${base}/api/company/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: config.publicOrigin },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json() as CompanySessionResponse;
  return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

describe('company startup config', () => {
  it('allows scoped preview assets without cookies only while their owner session remains authorized', async () => {
    const state=fixture(); let ownerKey='';
    const runtime=await initializeCompany({...state,config,resolvePreviewOwner:req=>req.path==='/api/projects/p/preview/cap/style.css'?{projectId:'p',ownerKey}:null});
    const owner=member(runtime,'preview-owner'); runtime.registerProjectOwner('p',owner);
    const session=runtime.auth.createSession(owner); ownerKey=`session:${session.token}`;
    const base=await start(runtime);
    expect((await fetch(`${base}/api/projects/p/preview/cap/style.css`)).status).toBe(200);
    runtime.store.deleteSession(session.token);
    expect((await fetch(`${base}/api/projects/p/preview/cap/style.css`)).status).toBe(401);
    expect((await fetch(`${base}/api/projects/p/preview/cap/style.css`,{method:'POST'})).status).toBe(403);
  });
  it('serves safe bootstrap metadata without a login and discards prelogin telemetry', async () => {
    const runtime = await initializeCompany({...fixture(),config});
    const base = await start(runtime);
    expect((await fetch(`${base}/api/version`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/analytics/config`)).json()).toMatchObject({enabled:false,key:null,host:null});
    expect((await fetch(`${base}/api/observability/event`,{method:'POST',headers:{origin:config.publicOrigin,'content-type':'application/json'},body:'{}'})).status).toBe(204);
    expect((await fetch(`${base}/api/projects`)).status).toBe(401);
  });
  it('scopes live artifact reads to an authorized project query', async () => {
    const runtime=await initializeCompany({...fixture(),config});
    const owner=member(runtime,'artifact-owner'); runtime.registerProjectOwner('p',owner);
    const session=runtime.auth.createSession(owner); const base=await start(runtime);
    const headers={cookie:`od_company_session=${session.token}`};
    expect((await fetch(`${base}/api/live-artifacts?projectId=p`,{headers})).status).toBe(200);
    expect((await fetch(`${base}/api/live-artifacts?projectId=other`,{headers})).status).toBe(403);
    expect((await fetch(`${base}/api/live-artifacts`,{headers})).status).toBe(403);
  });
  it('loads the approved schema and interpolates only NEXUS secrets in values', () => {
    const { dataRoot } = fixture();
    writeFileSync(path.join(dataRoot, 'company.yaml'), `
authentication:
  enabled: true
  default_provider: ldap
  local_admin: { enabled: true, username: admin }
  providers:
    ldap:
      bind_mode: service
      url: ldaps://directory.test
      base_dn: dc=test
      user_base_dn: ou=people,dc=test
      user_filter: '(uid={username})'
      username_attribute: uid
      bind_dn: cn=service,dc=test
      bind_password: '${'$'}{NEXUS_LDAP_PASSWORD}'
      verify_tls: true
      auto_create_local_user: true
server: { public_origin: 'http://company.test' }
presentation: { show_agent_identity: false, hidden_settings_sections: [labs, integrations] }
`);
    const loaded = loadCompanyConfig(dataRoot, { NEXUS_LDAP_PASSWORD: 'colon: # stays a scalar' });
    expect(loaded.auth.ldap?.bindPassword).toBe('colon: # stays a scalar');
    expect(loaded.auth.ldap?.baseDn).toBe('ou=people,dc=test');
    expect(loaded.publicOrigin).toBe('http://company.test');
    writeFileSync(path.join(dataRoot, 'company.yaml'), 'authentication: { enabled: true }\nserver: { public_origin: "${HOME}" }');
    expect(() => loadCompanyConfig(dataRoot, {})).toThrow(/NEXUS/);
  });

  it('fails closed when company authentication is removed after initialization', async () => {
    const deps = fixture();
    await initializeCompany({ ...deps, config });
    await expect(initializeCompany({ ...deps, config: { ...config, enabled: false } })).rejects.toThrow(/disable/);
  });
});

describe('company authentication and project ACL', () => {
  it('bootstraps once, forces password change and never stores plaintext passwords', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config });
    const bootstrap = readFileSync(path.join(deps.dataRoot, 'company-admin-bootstrap.txt'), 'utf8').trim();
    const base = await start(runtime);
    const session = await login(base, 'admin', bootstrap);
    expect(session.response.status).toBe(200);
    expect(session.body.user?.mustChangePassword).toBe(true);
    expect(session.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(session.response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect((await fetch(`${base}/api/projects`, { headers: { cookie: session.cookie } })).status).toBe(403);
    const changed = await fetch(`${base}/api/company/auth/password`, {
      method: 'POST', headers: { cookie: session.cookie, origin: config.publicOrigin, 'x-csrf-token': session.body.csrfToken!, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: bootstrap, newPassword: 'a-long-new-password-42' }),
    });
    expect(changed.status).toBe(200);
    expect((await changed.json() as CompanySessionResponse).user?.mustChangePassword).toBe(false);
    expect(() => readFileSync(path.join(deps.dataRoot, 'company-admin-bootstrap.txt'))).toThrow();
    await initializeCompany({ ...deps, config });
    expect(() => readFileSync(path.join(deps.dataRoot, 'company-admin-bootstrap.txt'))).toThrow();
    const persisted = JSON.stringify(deps.database.prepare('SELECT * FROM company_users').all());
    expect(persisted).not.toContain(bootstrap);
    expect(persisted).not.toContain('a-long-new-password-42');
  });

  it('denies guests, cross-origin mutations, and unknown member capabilities', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config });
    const employee = member(runtime, 'alice');
    const session = runtime.auth.createSession(employee);
    const base = await start(runtime);
    const cookie = `od_company_session=${session.token}`;
    expect((await fetch(`${base}/api/projects`)).status).toBe(401);
    expect((await fetch(`${base}/API/projects`)).status).toBe(403);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/company/session`)).status).toBe(200);
    expect((await fetch(`${base}/api/something-new`, { headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie, origin: 'http://evil.test', 'x-csrf-token': session.csrfToken } })).status).toBe(403);
    expect((await fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie, origin: config.publicOrigin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'new', name: 'new', metadata: { linkedDirs: ['/host-private'] } }) })).status).toBe(403);
    expect((await fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie, origin: config.publicOrigin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'new', name: 'new', projectLocationId: 'private-host-location' }) })).status).toBe(403);
    expect((await fetch(`${base}/api/company/auth/login`, { method: 'POST', headers: { origin: 'http://evil.test', 'content-type': 'application/json' }, body: '{"username":"admin","password":"wrong"}' })).status).toBe(403);
    expect((await fetch(`${base}/api/mcp`, { headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${base}/api/projects/p/terminal`, { headers: { cookie } })).status).toBe(403);
  });

  it('keeps projects private, enforces viewer/editor ownership, and revokes immediately', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config });
    const owner = member(runtime, 'owner');
    const viewer = member(runtime, 'viewer');
    runtime.registerProjectOwner('private-project', owner);
    expect(runtime.canAccess(viewer, 'private-project')).toBe(false);
    runtime.store.setMember('private-project', viewer.id, 'viewer', owner.id);
    expect(runtime.canAccess(viewer, 'private-project')).toBe(true);
    expect(runtime.canAccess(viewer, 'private-project', true)).toBe(false);
    const base = await start(runtime);
    const session = runtime.auth.createSession(viewer);
    const headers = { cookie: `od_company_session=${session.token}`, origin: config.publicOrigin, 'x-csrf-token': session.csrfToken };
    expect((await fetch(`${base}/api/projects/private-project/files`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/other-project/files`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/api/projects/private-project/files/a`, { method: 'POST', headers })).status).toBe(403);
    runtime.store.setMember('private-project', viewer.id, 'editor', owner.id);
    expect((await fetch(`${base}/api/projects/private-project/files/a`, { method: 'POST', headers })).status).toBe(200);
    runtime.store.removeMember('private-project', viewer.id, owner.id);
    expect((await fetch(`${base}/api/projects/private-project/files`, { headers })).status).toBe(403);
    runtime.store.updateUser(viewer.id, { disabled: true }, owner.id);
    expect((await fetch(`${base}/api/company/session`, { headers }).then((r) => r.json()) as CompanySessionResponse).user).toBeNull();
    expect((await fetch(`${base}/api/projects`, { headers })).status).toBe(401);
    expect(deps.database.prepare('SELECT COUNT(*) AS n FROM company_audit').get()).toMatchObject({ n: 5 });
  });

  it('lets project viewers export and resolve workspace scope while upload remains editor-only', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config });
    const owner = member(runtime, 'owner');
    const viewer = member(runtime, 'viewer');
    runtime.registerProjectOwner('p1', owner);
    runtime.store.setMember('p1', viewer.id, 'viewer', owner.id);
    const session = runtime.auth.createSession(viewer);
    const headers = { cookie: `od_company_session=${session.token}`, origin: config.publicOrigin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' };
    const base = await start(runtime);
    for (const endpoint of ['workspace-scope', 'export/manifest', 'export/index.html', 'archive']) {
      expect((await fetch(`${base}/api/projects/p1/${endpoint}`, { headers })).status, endpoint).toBe(200);
      expect((await fetch(`${base}/api/projects/p2/${endpoint}`, { headers })).status, endpoint).toBe(403);
    }
    for (const endpoint of ['export', 'export/html', 'export/pdf', 'export/pdf-image', 'export/image', 'export/pptx', 'archive/batch']) {
      expect((await fetch(`${base}/api/projects/p1/${endpoint}`, { method: 'POST', headers, body: '{}' })).status, endpoint).toBe(200);
      expect((await fetch(`${base}/api/projects/p2/${endpoint}`, { method: 'POST', headers, body: '{}' })).status, endpoint).toBe(403);
    }
    expect((await fetch(`${base}/api/projects/p1/upload`, { method: 'POST', headers })).status).toBe(403);
    runtime.store.setMember('p1', viewer.id, 'editor', owner.id);
    expect((await fetch(`${base}/api/projects/p1/upload`, { method: 'POST', headers })).status).toBe(200);
  });

  it('runs company authentication before the safe member bootstrap response policy', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config });
    const employee = member(runtime, 'member');
    const session = runtime.auth.createSession(employee);
    const app = express();
    app.use(express.json()); app.use(runtime.middleware); app.use(runtime.router);
    installCompanyHttpPolicy(app, {
      company: runtime,
      readConfig: async () => ({ agentId: 'codex', agentModels: { codex: { model: 'managed' } }, agentCliEnv: { codex: { OPENAI_API_KEY: 'private-provider-key' } } }),
      detectAgents: async () => [{ id: 'codex', name: 'Codex', bin: 'codex', available: true, authStatus: 'ok', path: '/private/host/tool' }],
    });
    app.get('/api/plugins', (_req, res) => res.json({ plugins: [] }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    resources.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await fetch(`${base}/api/app-config`)).status).toBe(401);
    const headers = { cookie: `od_company_session=${session.token}` };
    expect(await fetch(`${base}/api/workspace/directory`, { headers }).then((r) => r.json())).toEqual({ items: [], activeWorkspaceId: null });
    expect(await fetch(`${base}/api/app-config`, { headers }).then((r) => r.text())).not.toContain('private-provider-key');
    expect(await fetch(`${base}/api/agents?stream=1`, { headers }).then((r) => r.text())).toContain('event: agent');
    expect((await fetch(`${base}/api/plugins`, { headers })).status).toBe(200);
  });

  it('expires sessions after eight hours and hashes persisted tokens', async () => {
    const deps = fixture();
    let now = 1000;
    const runtime = await initializeCompany({ ...deps, config, now: () => now });
    const user = member(runtime, 'alice');
    const session = runtime.auth.createSession(user);
    expect(runtime.store.getSession(session.token, now)?.user.id).toBe(user.id);
    expect(JSON.stringify(deps.database.prepare('SELECT * FROM company_sessions').all())).not.toContain(session.token);
    now += 8 * 60 * 60 * 1000;
    expect(runtime.store.getSession(session.token, now)).toBeNull();
  });

  it('allows owners to share and prevents viewers from granting access or deleting projects', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config });
    const owner = member(runtime, 'owner');
    const viewer = member(runtime, 'viewer');
    runtime.registerProjectOwner('p1', owner);
    const base = await start(runtime);
    const session = runtime.auth.createSession(owner);
    const headers = { cookie: `od_company_session=${session.token}`, origin: config.publicOrigin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' };
    expect((await fetch(`${base}/api/company/projects/p1/members`, { method: 'PUT', headers, body: JSON.stringify({ userId: viewer.id, role: 'viewer' }) })).status).toBe(200);
    const viewerSession = runtime.auth.createSession(viewer);
    const viewerHeaders = { ...headers, cookie: `od_company_session=${viewerSession.token}`, 'x-csrf-token': viewerSession.csrfToken };
    expect((await fetch(`${base}/api/company/projects/p1/members`, { method: 'PUT', headers: viewerHeaders, body: JSON.stringify({ userId: viewer.id, role: 'editor' }) })).status).toBe(403);
    expect((await fetch(`${base}/api/projects/p1`, { method: 'DELETE', headers: viewerHeaders })).status).toBe(403);
    expect((await fetch(`${base}/api/projects/p1`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/p1`, { method: 'PATCH', headers, body: JSON.stringify({ metadata: { baseDir: '/host-secret' } }) })).status).toBe(403);
    expect((await fetch(`${base}/api/projects/p1`, { method: 'PATCH', headers, body: JSON.stringify({ pendingPrompt: null }) })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/p1`, { method: 'PATCH', headers, body: JSON.stringify({ name: 'Generated name', metadata: { kind: 'other', nameSource: 'agent' } }) })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/p1`, { method: 'PATCH', headers, body: JSON.stringify({ metadata: { kind: '../../outside' } }) })).status).toBe(403);
    expect((await fetch(`${base}/api/projects/p1`, { method: 'PATCH', headers, body: JSON.stringify({ metadata: { kind: 'other', entryFile: '../outside' } }) })).status).toBe(403);
    expect((await fetch(`${base}/api/projects/p1`, { method: 'PATCH', headers, body: JSON.stringify({ pendingPrompt: 'injected prompt' }) })).status).toBe(403);
    expect((await fetch(`${base}/api/projects/p1`, { method: 'PATCH', headers: viewerHeaders, body: JSON.stringify({ pendingPrompt: null }) })).status).toBe(403);
    expect((await fetch(`${base}/api/company/projects/p1/members/${owner.id}`, { method: 'DELETE', headers })).status).toBe(400);
    expect((await fetch(`${base}/artifacts/unscoped-secret`, { headers: viewerHeaders })).status).toBe(403);
  });

  it('notifies active work on logout and permission reductions, but keeps grants running', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config });
    const owner = member(runtime, 'owner');
    const target = member(runtime, 'target');
    runtime.registerProjectOwner('p1', owner);
    const events: Array<{ userId: string; projectId?: string }> = [];
    runtime.onRevoke((event) => events.push(event));
    runtime.store.setMember('p1', target.id, 'editor', owner.id);
    expect(events).toEqual([]);
    runtime.store.setMember('p1', target.id, 'viewer', owner.id);
    expect(events).toEqual([{ userId: target.id, projectId: 'p1', reason: 'permissions' }]);
    const session = runtime.auth.createSession(target);
    const base = await start(runtime);
    const response = await fetch(`${base}/api/company/auth/logout`, { method: 'POST', headers: {
      cookie: `od_company_session=${session.token}`, origin: config.publicOrigin, 'x-csrf-token': session.csrfToken,
    } });
    expect(response.status).toBe(200);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ userId: target.id, reason: 'logout' });
    expect(runtime.store.getSession(session.token)).toBeNull();
  });

  it('keeps tab state private to each participant and lets viewers save their own tabs', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config });
    const owner = member(runtime, 'owner');
    const viewer = member(runtime, 'viewer');
    runtime.registerProjectOwner('p1', owner);
    runtime.store.setMember('p1', viewer.id, 'viewer', owner.id);
    const base = await start(runtime);
    const session = runtime.auth.createSession(viewer);
    const headers = { cookie: `od_company_session=${session.token}`, origin: config.publicOrigin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' };
    const saved = await fetch(`${base}/api/projects/p1/tabs`, { method: 'PUT', headers, body: JSON.stringify({ tabs: ['index.html'], active: 'index.html', browserTabs: [{ id: 'browser-1', label: 'Docs', url: 'https://example.test' }, { invalid: true }] }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ tabs: ['index.html'], active: 'index.html', browserTabs: [{ id: 'browser-1', label: 'Docs', url: 'https://example.test' }], hasSavedState: true });
    const ownerSession = runtime.auth.createSession(owner);
    const initial = await fetch(`${base}/api/projects/p1/tabs`, { headers: { cookie: `od_company_session=${ownerSession.token}` } });
    expect(await initial.json()).toEqual({ tabs: [], active: null, hasSavedState: false });
    expect((await fetch(`${base}/api/projects/p1/tabs`, { method: 'PUT', headers, body: '{"tabs":[1]}' })).status).toBe(400);
  });

  it('provisions local members only through administrators and never falls back from LDAP', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config });
    const admin = runtime.store.findUser('admin')!;
    runtime.store.changePassword(admin.id, 'administrator-password');
    const session = runtime.auth.createSession(runtime.store.getUser(admin.id)!);
    const base = await start(runtime);
    const response = await fetch(`${base}/api/company/users`, { method: 'POST', headers: {
      cookie: `od_company_session=${session.token}`, origin: config.publicOrigin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json',
    }, body: JSON.stringify({ username: 'employee', password: 'temporary-employee-password' }) });
    expect(response.status).toBe(201);
    expect(await runtime.auth.login('employee', 'temporary-employee-password', 'test')).toMatchObject({ username: 'employee', source: 'local', role: 'member', mustChangePassword: true });
    const ldapRuntime = await initializeCompany({ ...deps, config: { ...config, auth: { mode: 'ldap' } }, ldap: { authenticate: async () => null, recheck: async () => false } });
    expect(await ldapRuntime.auth.login('employee', 'temporary-employee-password', 'test')).toBeNull();
  });

  it('constrains signed task credentials to one project even when the actor is an administrator', async () => {
    const deps = fixture();
    const first = await initializeCompany({ ...deps, config });
    const admin = first.store.findUser('admin')!;
    first.store.changePassword(admin.id, 'administrator-password');
    const runtime = await initializeCompany({ ...deps, config, authenticateTask: (req) => req.get('authorization') === 'Bearer signed-task' ? { userId: admin.id, projectId: 'p1' } : null });
    const base = await start(runtime);
    const headers = { authorization: 'Bearer signed-task' };
    expect((await fetch(`${base}/api/projects/p1/files`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/p2/files`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/api/projects/p1/files/index.html`, { method: 'POST', headers })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/p1`, { method: 'DELETE', headers })).status).toBe(403);
    expect((await fetch(`${base}/api/company/users`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/api/config`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/api/runs`, { method: 'POST', headers })).status).toBe(403);
  });

  it('requires a physical tool grant for signed tool requests and forwards only that grant', async () => {
    const deps = fixture();
    const first = await initializeCompany({ ...deps, config });
    const user = member(first, 'employee');
    first.registerProjectOwner('p1', user);
    const runtime = await initializeCompany({ ...deps, config, authenticateTask: (req) => {
      const token = req.get('authorization');
      if (token === 'Bearer signed-task') return { userId: user.id, projectId: 'p1', legacyToolToken: 'physical-project-tool-grant' };
      if (token === 'Bearer task-without-tool-grant') return { userId: user.id, projectId: 'p1' };
      return null;
    } });
    const base = await start(runtime);
    expect((await fetch(`${base}/api/tools/design-systems/read`, { method: 'POST', headers: { authorization: 'Bearer task-without-tool-grant' } })).status).toBe(403);
    const allowed = await fetch(`${base}/api/tools/design-systems/read`, { method: 'POST', headers: { authorization: 'Bearer signed-task' } });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ authorization: 'Bearer physical-project-tool-grant' });
    expect((await fetch(`${base}/api/tools/connectors/list`, { headers: { authorization: 'Bearer signed-task' } })).status).toBe(403);
  });

  it('closes an active project stream immediately when its read access is revoked', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config });
    const owner = member(runtime, 'owner');
    const viewer = member(runtime, 'viewer');
    runtime.registerProjectOwner('p1', owner);
    runtime.store.setMember('p1', viewer.id, 'viewer', owner.id);
    const session = runtime.auth.createSession(viewer);
    const base = await start(runtime);
    const response = await fetch(`${base}/api/projects/p1/events`, { headers: { cookie: `od_company_session=${session.token}` } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    runtime.store.removeMember('p1', viewer.id, owner.id);
    expect((await reader.read()).done).toBe(true);
  });

  it('links LDAP renames through entryUUID and rechecks sessions after five minutes', async () => {
    const deps = fixture();
    let active = true;
    let now = 1000;
    const ldap: CompanyLdap = {
      authenticate: async (_username, password) => password === 'directory-password' ? { entryUUID: 'stable-id', username: 'alice' } : null,
      recheck: async () => active,
    };
    const runtime = await initializeCompany({ ...deps, config: { ...config, auth: { mode: 'ldap' } }, ldap, now: () => now });
    const base = await start(runtime);
    const session = await login(base, 'alice', 'directory-password');
    expect(session.response.status).toBe(200);
    const renamed = runtime.store.upsertLdapUser({ entryUUID: 'stable-id', username: 'alice.renamed' });
    expect(renamed.id).toBe(session.body.user?.id);
    expect(JSON.stringify(deps.database.prepare('SELECT * FROM company_users').all())).not.toContain('directory-password');
    active = false;
    now += 5 * 60 * 1000;
    expect((await fetch(`${base}/api/projects`, { headers: { cookie: session.cookie } })).status).toBe(401);
    expect(runtime.store.getSession(session.cookie.split('=')[1]!, now)).toBeNull();
  });

  it('rechecks background LDAP eligibility without a browser and rejects revoked task credentials', async () => {
    const deps = fixture();
    let now = 1000;
    let active = true;
    const runtime = await initializeCompany({
      ...deps, config: { ...config, auth: { mode: 'ldap' } }, now: () => now,
      ldap: { authenticate: async () => ({ entryUUID: 'entry-1', username: 'employee' }), recheck: async () => active },
      authenticateTask: () => ({ userId: runtime.store.findUser('employee')!.id, projectId: 'p1' }),
    });
    const employee = (await runtime.auth.login('employee', 'directory-password', 'test'))!;
    runtime.registerProjectOwner('p1', employee);
    const session = runtime.auth.createSession(employee);
    expect(await runtime.auth.userEligible(employee.id)).toBe(true);
    active = false;
    now += 5 * 60 * 1000 - 1;
    expect(await runtime.auth.userEligible(employee.id)).toBe(true);
    now += 1;
    expect(await runtime.auth.userEligible(employee.id)).toBe(false);
    expect(runtime.store.getSession(session.token, now)).toBeNull();
    const base = await start(runtime);
    expect((await fetch(`${base}/api/projects/p1/files`, { headers: { authorization: 'Bearer task' } })).status).toBe(403);
  });

  it('fails background eligibility closed when the directory is unavailable', async () => {
    const deps = fixture();
    const runtime = await initializeCompany({ ...deps, config: { ...config, auth: { mode: 'ldap' } }, ldap: {
      authenticate: async () => null,
      recheck: async () => { throw new Error('directory unavailable'); },
    } });
    const employee = runtime.store.upsertLdapUser({ entryUUID: 'entry-1', username: 'employee' });
    const session = runtime.auth.createSession(employee);
    expect(await runtime.auth.userEligible(employee.id)).toBe(false);
    expect(runtime.store.getSession(session.token)).toBeNull();
  });

  it('invalidates sessions when authentication mode or LDAP identity configuration changes', async () => {
    const deps = fixture();
    const first = await initializeCompany({ ...deps, config });
    const local = member(first, 'local-member');
    const initial = first.auth.createSession(local);
    await initializeCompany({ ...deps, config: { ...config, presentation: { ...config.presentation, showAgentIdentity: true } } });
    expect(first.store.getSession(initial.token)?.user.id).toBe(local.id);
    const ldapConfig = {
      ...config, auth: { mode: 'ldap' as const, ldap: {
        url: 'ldaps://directory.test', baseDn: 'ou=people,dc=test', bindDn: 'cn=service,dc=test', bindPassword: 'original-secret',
        userFilter: '(uid={username})', usernameAttribute: 'uid', entryUUIDAttribute: 'entryUUID', displayNameAttribute: 'cn',
        startTls: false, verifyTls: true, connectTimeoutMs: 5000, searchTimeoutMs: 5000, autoCreate: true,
      } },
    };
    const ldap: CompanyLdap = { authenticate: async () => ({ entryUUID: 'entry-1', username: 'employee' }), recheck: async () => true };
    const second = await initializeCompany({ ...deps, config: ldapConfig, ldap });
    expect(second.store.getSession(initial.token)).toBeNull();
    const employee = (await second.auth.login('employee', 'directory-password', 'test'))!;
    const session = second.auth.createSession(employee);
    await initializeCompany({ ...deps, config: { ...ldapConfig, auth: { ...ldapConfig.auth, ldap: { ...ldapConfig.auth.ldap, bindPassword: 'rotated-secret' } } }, ldap });
    expect(second.store.getSession(session.token)).toBeNull();
    const persisted = JSON.stringify(deps.database.prepare('SELECT * FROM company_state').all());
    expect(persisted).not.toContain('original-secret');
    expect(persisted).not.toContain('rotated-secret');
  });

  it('escapes LDAP filters and binds the returned DN rather than a username DN template', async () => {
    const calls: string[] = [];
    const directory = createLdapDirectory({
      url: 'ldaps://directory.test', baseDn: 'ou=people,dc=test', bindDn: 'cn=service,dc=test', bindPassword: 'service-password',
      userFilter: '(uid={username})', usernameAttribute: 'uid', entryUUIDAttribute: 'entryUUID', displayNameAttribute: 'cn',
      startTls: false, verifyTls: true, connectTimeoutMs: 5000, searchTimeoutMs: 5000, autoCreate: true,
    }, () => ({
      bind: async (dn: string, password: string) => { calls.push(`bind:${dn}:${password}`); },
      search: async (_base: string, options: { filter?: string }) => {
        calls.push(`filter:${options.filter}`);
        return { searchEntries: [{ dn: 'uid=canonical,ou=people,dc=test', uid: 'canonical', entryUUID: 'id1' }] };
      },
      unbind: async () => {}, startTLS: async () => {},
    }));
    expect(await directory.authenticate('a*)(uid=*)', 'password')).toMatchObject({ username: 'canonical', entryUUID: 'id1' });
    expect(calls).toEqual(['bind:cn=service,dc=test:service-password', 'filter:(uid=a\\2a\\29\\28uid=\\2a\\29)', 'bind:uid=canonical,ou=people,dc=test:password']);
  });
});
