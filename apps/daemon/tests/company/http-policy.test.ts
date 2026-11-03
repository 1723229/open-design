import { afterEach, expect, test } from 'vitest';
import express from 'express';
import { request, type Server } from 'node:http';
import { createCompanyModelAdmissionHolds, installCompanyHttpPolicy } from '../../src/company/http-policy.js';
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>{s.closeAllConnections();s.close(()=>r());}))); });
test.each(['/api/runs', '/api/chat'])('does not retain a disconnected request rejected by company input validation through %s', async route => {
  let entered!: () => void; const preparing = new Promise<void>(r => { entered = r; });
  let resume!: () => void; const gate = new Promise<void>(r => { resume = r; });
  let closed!: () => void; const disconnected = new Promise<void>(r => { closed = r; });
  let responded!: () => void; const done = new Promise<void>(r => { responded = r; });
  const admissions = createCompanyModelAdmissionHolds();
  let holds = 0;
  const app = express(); app.use(express.json());
  app.use((_req, res, next) => {
    res.once('close', closed);
    const json = res.json.bind(res);
    res.json = body => { const result = json(body); responded(); return result; };
    next();
  });
  installCompanyHttpPolicy(app, {
    company: { enabled: true, getUser: () => ({ id: 'u', username: 'admin', role: 'admin', mustChangePassword: false, source: 'local', disabled: false }) },
    readConfig: async () => { entered(); await gate; return {}; }, detectAgents: async () => [],
    models: { pinActive: () => ({ agentId: 'codex', protocol: 'responses', providerId: 'p', providerRevision: 1, model: 'm' }) },
    holdModelRoute(req, res, pinned) { holds++; admissions.holdModelRoute(req, res, pinned); },
  });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(r => server.once('listening', r));
  const req = request(`http://127.0.0.1:${(server.address() as {port: number}).port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {}); req.end(JSON.stringify({ imagePaths: ['outside.png'] }));
  await preparing; req.destroy(); await disconnected;
  resume(); await done;
  expect(holds).toBe(0); expect(admissions.routes.size).toBe(0);
});
test('member bootstrap filters credentials and returns the supported SSE protocol', async () => {
  const app = express(); app.use(express.json());
  installCompanyHttpPolicy(app, {
    company: {enabled:true,getUser:()=>({id:'u',username:'member',role:'member',mustChangePassword:false,source:'local',disabled:false})},
    readConfig: async()=>({agentId:'codex',agentModels:{codex:{model:'model'}},agentCliEnv:{codex:{OPENAI_API_KEY:'SECRET'}}}),
    detectAgents: async()=>[{id:'codex',name:'Codex',bin:'codex',available:false,authStatus:'missing',path:'/private/config',diagnostics:[]}],
    projectIsExecuting: id=>id==='busy',
  });
  app.post('/api/runs',(req,res)=>res.json(req.body));
  app.get('/api/projects/p/files/a.html',(_req,res)=>res.type('html').send('<script>1</script>'));
  app.get('/api/projects/p/powered/a.html',(_req,res)=>res.type('html').send('<script>1</script>'));
  app.post('/api/projects/busy/files',(_req,res)=>res.json({ok:true}));
  app.post('/api/projects/busy/conversations/c/comments',(_req,res)=>res.json({ok:true}));
  app.put('/api/projects/busy/conversations/c/messages/m',(_req,res)=>res.json({ok:true}));
  app.patch('/api/projects/busy/conversations/c',(_req,res)=>res.json({ok:true}));
  app.patch('/api/projects/busy',(_req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1'); servers.push(server);
  await new Promise<void>(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  expect(await (await fetch(`${base}/api/app-config`)).text()).not.toContain('SECRET');
  const stream=await (await fetch(`${base}/api/agents?stream=1`)).text();
  expect(stream).toContain('event: agent'); expect(stream).toContain('event: done');
  expect(stream).toContain('"available":false'); expect(stream).not.toContain('/private/config');
  expect(await (await fetch(`${base}/api/workspace/directory`)).json()).toEqual({items:[],activeWorkspaceId:null});
  const first=await (await fetch(`${base}/api/runs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientRequestId:'same',agentId:'claude',model:'evil'})})).json() as Record<string,unknown>;
  const second=await (await fetch(`${base}/api/runs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientRequestId:'same'})})).json() as Record<string,unknown>;
  expect(first.agentId).toBe('codex'); expect(first.model).toBe('model'); expect(first.clientRequestId).toBe(second.clientRequestId);
  expect((await fetch(`${base}/api/projects/p/files/a.html`)).headers.get('content-security-policy')).toContain('sandbox');
  expect((await fetch(`${base}/api/projects/p/powered/a.html`)).status).toBe(403);
  expect((await fetch(`${base}/api/projects/busy/files`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(409);
  expect((await fetch(`${base}/api/projects/busy/conversations/c/comments`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(200);
  expect((await fetch(`${base}/api/projects/busy/conversations/c/messages/m`,{method:'PUT',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(200);
  expect((await fetch(`${base}/api/projects/busy/conversations/c`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Generated title'})})).status).toBe(200);
  expect((await fetch(`${base}/api/projects/busy`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Generated name',metadata:{kind:'other',nameSource:'agent'}})})).status).toBe(200);
  expect((await fetch(`${base}/api/projects/busy`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({metadata:{baseDir:'/host'}})})).status).toBe(409);
});

test('unified settings project safe defaults and pin the server route on submission', async () => {
  const route = { agentId: 'claude' as const, providerId: 'provider', providerRevision: 2, model: 'new-model', protocol: 'anthropic-messages' as const };
  const app = express(); app.use(express.json());
  installCompanyHttpPolicy(app, {
    company: { enabled: true, getUser: () => ({ id: 'admin', username: 'admin', role: 'admin', mustChangePassword: false, source: 'local', disabled: false }) },
    readConfig: async () => ({ agentId: 'codex', agentModels: { codex: { model: 'old' } }, agentCliEnv: { codex: { OPENAI_API_KEY: 'PRIVATE' } } }),
    detectAgents: async () => [], models: { pinActive: () => route },
  });
  app.post('/api/runs', (req, res) => res.json(req.body));
  app.put('/api/app-config', (req, res) => res.json({ config: { ...req.body, agentId: 'codex', agentCliEnv: { codex: { OPENAI_API_KEY: 'PRIVATE' } } } }));
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const configResponse = await fetch(`${base}/api/app-config`);
  expect(configResponse.status).toBe(200);
  const config = await configResponse.json() as {config:Record<string,unknown>};
  expect(config.config).toMatchObject({ agentId: 'claude', agentModels: { claude: { model: 'new-model' } } });
  expect(JSON.stringify(config)).not.toContain('PRIVATE');
  const run = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'codex', model: 'evil', companyModelRoute: { providerId: 'attacker' } }) }).then(r => r.json()) as Record<string,unknown>;
  expect(run.companyModelRoute).toEqual(route);
  expect(run.agentId).toBe('claude');
  const bypass = await fetch(`${base}/api/app-config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'codex' }) });
  expect(bypass.status).toBe(409);
  const preference = await fetch(`${base}/api/app-config`, { method: 'PUT', headers: { 'content-type':'application/json' }, body:JSON.stringify({agentId:'codex',customInstructions:'New rule'}) });
  expect(preference.status).toBe(200);
  const saved = await preference.json() as {config:Record<string,unknown>};
  expect(saved.config).toMatchObject({agentId:'claude',customInstructions:'New rule'});
  expect(JSON.stringify(saved)).not.toContain('PRIVATE');
});

test('original reasoning and service-tier preferences save without changing managed routing or keys', async () => {
  const route = { agentId:'codex' as const, protocol:'responses' as const, providerId:'p', providerRevision:1, model:'managed' };
  const original = { agentId:'codex', agentModels:{ codex:{ model:'legacy', reasoning:'low', serviceTier:'fast' }, claude:{ model:'legacy-claude' } }, agentCliEnv:{ codex:{ OPENAI_API_KEY:'PRIVATE' } } };
  const app = express(); app.use(express.json());
  installCompanyHttpPolicy(app, {
    company:{ enabled:true, getUser:()=>({id:'u',username:'admin',role:'admin',mustChangePassword:false,source:'local',disabled:false}) },
    readConfig:async()=>structuredClone(original), detectAgents:async()=>[], models:{ pinActive:()=>route },
  });
  let forwarded: Record<string, unknown> = {};
  app.put('/api/app-config', (req, res) => { forwarded = req.body; res.json({ config:{ ...original, ...req.body } }); });
  const server = app.listen(0,'127.0.0.1'); servers.push(server);
  await new Promise<void>(r=>server.once('listening',r));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const put = (body:unknown) => fetch(base+'/api/app-config', {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result = await put({ agentId:'claude', agentCliEnv:{claude:{ANTHROPIC_API_KEY:'ATTACK'}}, agentModels:{codex:{model:'forged',reasoning:'high',serviceTier:null},arbitrary:{reasoning:'x'}} });
  expect(result.status).toBe(200);
  expect(forwarded).toEqual({agentModels:{codex:{model:'legacy',reasoning:'high'},claude:{model:'legacy-claude'}}});
  const projected = await result.json() as {config:{agentId:string;agentModels:Record<string, unknown>}};
  expect(projected.config.agentId).toBe('codex');
  expect(projected.config.agentModels.codex).toEqual({model:'managed',reasoning:'high'});
  expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|ATTACK|forged/);
  expect((await put({agentModels:{codex:{reasoning:[]}}})).status).toBe(400);
  expect((await put({agentModels:{codex:{model:'forged'}}})).status).toBe(409);
  const cleared = await put({agentModels:{codex:{reasoning:''}}});
  expect(cleared.status).toBe(200);
  expect((forwarded.agentModels as typeof original.agentModels).codex).toEqual({model:'legacy',serviceTier:'fast'});
});
