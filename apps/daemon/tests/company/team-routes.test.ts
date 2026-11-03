import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { initializeCompany } from '../../src/company/routes.js';
import { companyTestDatabase } from './database.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  let time = Date.now();
  const database = companyTestDatabase();
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'od-teams-'));
  cleanups.push(() => { database.close(); rmSync(dataRoot, {recursive: true, force: true}); });
  const runtime = await initializeCompany({database, dataRoot, now: () => time,
    config: { enabled: true, publicOrigin: 'http://design.test', auth: { mode: 'ldap' }, teams: {enabled: true},
      integrations: [{id: 'source', authorizeUrl: 'http://source.test/authorize', secret: 'test-secret-at-least-32-bytes-long'}],
      presentation: {showAgentIdentity: false, hiddenSettingsSections: []} },
    ldap: { authenticate: async () => null, recheck: async () => true, lookup: async id => ({entryUUID: id, username: id}) },
  });
  const app = express(); app.use(express.json()); app.use(runtime.middleware); app.use(runtime.router);
  app.post('/api/projects/:id/duplicate',(req,res)=>{runtime.claimProject(req,'duplicate',req.params.id);res.json({project:{id:'duplicate'}});});
  app.all('/{*path}', (_req, res) => res.json({ok: true}));
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  async function signed(endpoint: string, body?: unknown, nonce = randomBytes(16).toString('hex')) {
    const method = body ? 'POST' : 'GET', serialized = body ? JSON.stringify(body) : '';
    const ts = String(time);
    const signature = createHmac('sha256', 'test-secret-at-least-32-bytes-long')
      .update(`${method}\n${endpoint}\n${ts}\n${nonce}\n${createHash('sha256').update(serialized).digest('hex')}`).digest('hex');
    return fetch(base + endpoint, {method, headers: {'content-type': 'application/json', 'x-nexus-timestamp': ts, 'x-nexus-nonce': nonce, 'x-nexus-signature': signature}, ...(body ? {body: serialized} : {})});
  }
  const snapshot = {namespace: 'instance', externalId: 'business', expectedRevision: 0, complete: true, name: 'Business', status: 'active', members: [{entryUUID: 'alice', username: 'alice', role: 'viewer'}]};
  return {runtime, base, signed, snapshot, advance: (ms: number) => {time += ms;}};
}

it('authenticates signed snapshots independently of cookies and rejects replay', async () => {
  const f = await fixture(), endpoint = '/api/company/integrations/source/teams';
  const nonce = randomBytes(16).toString('hex');
  expect((await f.signed(endpoint, f.snapshot, nonce)).status).toBe(200);
  expect((await f.signed(endpoint, {...f.snapshot, expectedRevision: 1}, nonce)).status).toBe(403);
  expect((await fetch(f.base + endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(f.snapshot)})).status).toBe(403);
  expect((await f.signed(endpoint, {...f.snapshot, expectedRevision: 0})).status).toBe(409);
});

it('binds a one-time login to the browser, source, team and immutable LDAP identity', async () => {
  const f = await fixture();
  const response = await f.signed('/api/company/integrations/source/teams', f.snapshot);
  const {team} = await response.json() as {team: {id: string}};
  const start = await fetch(f.base + '/api/company/integrations/source/start?namespace=instance&externalId=business', {redirect: 'manual'});
  expect(start.status).toBe(302);
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const state = new URL(start.headers.get('location')!).searchParams.get('state');
  const codeResponse = await f.signed('/api/company/integrations/source/codes', {state, teamId: team.id, entryUUID: 'alice'});
  expect(codeResponse.status).toBe(200);
  const {code} = await codeResponse.json() as {code: string};
  const url = `${f.base}/api/company/integrations/source/callback?${new URLSearchParams({state: state!, code})}`;
  expect((await fetch(url, {redirect: 'manual'})).status).toBe(403);
  const callback = await fetch(url, {headers: {cookie}, redirect: 'manual'});
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toBe(`/teams/${team.id}`);
  expect(callback.headers.get('set-cookie')).toContain('od_company_session=');
  expect((await fetch(url, {headers: {cookie}, redirect: 'manual'})).status).toBe(403);
  const alice = f.runtime.store.findUser('alice')!;
  expect(alice.role).toBe('member');
  expect(f.runtime.store.teams.role(team.id, alice.id)).toBe('viewer');
  const sessionCookie=callback.headers.get('set-cookie')!.split(';')[0]!;
  const originalToken=sessionCookie.split('=')[1]!;
  const bothCookies=`${cookie}; ${sessionCookie}`;
  const nextStart=await fetch(f.base+'/api/company/integrations/source/start?namespace=instance&externalId=business',{headers:{cookie:bothCookies},redirect:'manual'});
  const nextState=new URL(nextStart.headers.get('location')!).searchParams.get('state')!;
  const nextCode=await (await f.signed('/api/company/integrations/source/codes',{state:nextState,teamId:team.id,entryUUID:'alice'})).json() as {code:string};
  expect((await fetch(`${f.base}/api/company/integrations/source/callback?${new URLSearchParams({state:nextState,code:nextCode.code})}`,{headers:{cookie:bothCookies},redirect:'manual'})).status).toBe(302);
  expect(f.runtime.store.getSession(originalToken)?.user.id).toBe(alice.id);
});

it('exposes team CRUD through the same authenticated session and blocks external member edits', async () => {
  const f = await fixture();
  const {team} = await (await f.signed('/api/company/integrations/source/teams', f.snapshot)).json() as {team: {id: string}};
  const actor = f.runtime.store.findUser('alice')!;
  const session = f.runtime.auth.createSession(actor);
  const headers = {cookie: `od_company_session=${session.token}`, origin: 'http://design.test', 'x-csrf-token': session.csrfToken, 'content-type': 'application/json'};
  expect((await fetch(f.base + `/api/company/teams/${team.id}/members`, {method: 'PUT', headers, body: JSON.stringify({userId: actor.id, role: 'admin'})})).status).toBe(403);
  const local = await fetch(f.base + '/api/company/teams', {method: 'POST', headers, body: JSON.stringify({name: 'Local'})});
  expect(local.status).toBe(201);
  expect((await local.json() as {team: {source: string}}).team.source).toBe('local');
  expect((await fetch(f.base + '/api/company/teams', {headers})).status).toBe(200);
});

it('rejects expired authorization codes and cannot change a reserved local admin identity', async () => {
  const f = await fixture();
  expect((await f.signed('/api/company/integrations/source/teams', {...f.snapshot, members: [{entryUUID:'intruder', username:'admin', role:'owner'}]})).status).toBe(400);
  await f.signed('/api/company/integrations/source/teams', f.snapshot);
  const teamId = f.runtime.store.teams.mappings('source')[0]!.teamId;
  const start = await fetch(f.base + '/api/company/integrations/source/start?namespace=instance&externalId=business', {redirect:'manual'});
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const {code} = await (await f.signed('/api/company/integrations/source/codes', {state,teamId,entryUUID:'alice'})).json() as {code:string};
  f.advance(60_001);
  const result = await fetch(`${f.base}/api/company/integrations/source/callback?${new URLSearchParams({state,code})}`, {redirect:'manual',headers:{cookie:start.headers.get('set-cookie')!.split(';')[0]!}});
  expect(result.status).toBe(403);
});

it('returns inherited team ownership from duplicate responses and ignores a caller team override',async()=>{
  const f=await fixture();
  const {team}=await(await f.signed('/api/company/integrations/source/teams',{...f.snapshot,members:[{entryUUID:'alice',username:'alice',role:'editor'}]})).json() as {team:{id:string}};
  const user=f.runtime.store.findUser('alice')!;f.runtime.store.teams.attach('p',team.id,user);
  const session=f.runtime.auth.createSession(user);
  const response=await fetch(f.base+'/api/projects/p/duplicate',{method:'POST',headers:{cookie:`od_company_session=${session.token}`,origin:'http://design.test','x-csrf-token':session.csrfToken,'content-type':'application/json'},body:JSON.stringify({companyTeamId:'unrelated-team'})});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({project:{id:'duplicate',companyTeamId:team.id,companyAccess:{canWrite:true,canManage:false,ownerUserId:user.id}}});
});

it('lets administrators export archived designs while refusing new generation',async()=>{
  const f=await fixture(),admin=f.runtime.store.findUser('admin')!;
  f.runtime.store.changePassword(admin.id,'test-admin-password');
  const actor=f.runtime.store.getUser(admin.id)!,team=f.runtime.store.teams.create('Archived',actor);
  f.runtime.store.teams.attach('p',team.id,actor);f.runtime.store.teams.update(team.id,{status:'archived'},actor);
  const session=f.runtime.auth.createSession(actor);
  const headers={cookie:`od_company_session=${session.token}`,origin:'http://design.test','x-csrf-token':session.csrfToken,'content-type':'application/json'};
  expect((await fetch(f.base+'/api/projects/p/export',{method:'POST',headers,body:'{}'})).status).toBe(200);
  expect((await fetch(f.base+'/api/runs',{method:'POST',headers,body:JSON.stringify({projectId:'p'})})).status).toBe(403);
});
