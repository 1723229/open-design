import { afterEach, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createCompanyModelProxy } from '../../src/company/model-proxy.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }))); });
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
}
test('proxy binds model and replaces scoped credentials without leaking provider key', async () => {
  let authorization: string | undefined;
  let body = '';
  const upstream = await listen(createServer(async (req, res) => {
    authorization = req.headers.authorization;
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type','text/event-stream');
    res.end('data: {"ok":true}\n\n');
  }));
  const proxy = await listen(createCompanyModelProxy({controlSecret:'control-secret'}));
  const control = {authorization:'Bearer control-secret','content-type':'application/json'};
  const registration = await fetch(`${proxy}/control/leases`, {method:'POST',headers:control,body:JSON.stringify({id:'job',token:'scoped-token',agentId:'codex',model:'allowed',baseUrl:upstream,apiKey:'real-provider-secret',protocol:'openai',expiresAt:Date.now()+60000})});
  expect(registration.status).toBe(201);
  const headers = {authorization:'Bearer scoped-token','content-type':'application/json'};
  expect((await fetch(`${proxy}/v1/responses`,{method:'POST',headers,body:'{"model":"forbidden"}'})).status).toBe(403);
  const response = await fetch(`${proxy}/v1/responses`,{method:'POST',headers,body:'{"model":"allowed","input":"hello"}'});
  expect(await response.text()).toContain('"ok":true');
  expect(authorization).toBe('Bearer real-provider-secret');
  expect(JSON.parse(body).model).toBe('allowed');
  await fetch(`${proxy}/control/leases/job`,{method:'DELETE',headers:control});
  expect((await fetch(`${proxy}/v1/responses`,{method:'POST',headers,body:'{}'})).status).toBe(401);
});
test('management and arbitrary upstream paths are unavailable to jobs', async () => {
  const proxy = await listen(createCompanyModelProxy({controlSecret:'control-secret'}));
  expect((await fetch(`${proxy}/control/leases`,{method:'POST',headers:{authorization:'Bearer scoped-token'}})).status).toBe(401);
  expect((await fetch(`${proxy}/api/company/users`)).status).toBe(404);
});

test('a pinned Responses lease cannot switch to another OpenAI wire protocol', async () => {
  const upstream = await listen(createServer((_req,res) => res.end('{}')));
  const proxy = await listen(createCompanyModelProxy({ controlSecret: 'control' }));
  const registration = await fetch(`${proxy}/control/leases`, { method: 'POST', headers: { authorization: 'Bearer control', 'content-type':'application/json' }, body: JSON.stringify({ id: 'job', token: 'task', agentId: 'codex', model: 'm', baseUrl: upstream, apiKey: 'private', protocol: 'openai', wireProtocol: 'responses', expiresAt: Date.now()+60000 }) });
  expect(registration.status).toBe(201);
  const options = { method: 'POST', headers: { authorization:'Bearer task','content-type':'application/json' }, body:'{"model":"m"}' };
  expect((await fetch(`${proxy}/v1/chat/completions`, options)).status).toBe(403);
  expect((await fetch(`${proxy}/v1/responses`, options)).status).toBe(200);
});
test('provider errors cannot echo the administrator credential into a task', async () => {
  const upstream=await listen(createServer((_req,res)=>{res.writeHead(401);res.end('invalid key provider-key-secret');}));
  const proxy=await listen(createCompanyModelProxy({controlSecret:'control-secret'}));
  await fetch(`${proxy}/control/leases`,{method:'POST',headers:{authorization:'Bearer control-secret','content-type':'application/json'},body:JSON.stringify({id:'job',token:'task',agentId:'codex',model:'m',baseUrl:upstream,apiKey:'provider-key-secret',protocol:'openai',expiresAt:Date.now()+60000})});
  const response=await fetch(`${proxy}/v1/responses`,{method:'POST',headers:{authorization:'Bearer task','content-type':'application/json'},body:'{}'});
  expect(response.status).toBe(401); expect(await response.text()).not.toContain('provider-key-secret');
});
test('revoking a task aborts an upstream stream even while provider stalls', async () => {
  let closed!: () => void;
  const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
  const upstream = await listen(createServer((req, res) => {
    req.resume(); res.writeHead(200, {'content-type':'text/event-stream'}); res.write('data: first\n\n');
    res.once('close',closed);
  }));
  const proxy = await listen(createCompanyModelProxy({controlSecret:'control-secret'}));
  const control = {authorization:'Bearer control-secret','content-type':'application/json'};
  await fetch(`${proxy}/control/leases`,{method:'POST',headers:control,body:JSON.stringify({id:'job',token:'scoped-token',agentId:'codex',model:'allowed',baseUrl:upstream,apiKey:'secret',protocol:'openai',expiresAt:Date.now()+60000})});
  const stream = await fetch(`${proxy}/v1/responses`,{method:'POST',headers:{authorization:'Bearer scoped-token','content-type':'application/json'},body:'{}'});
  await stream.body!.getReader().read();
  await fetch(`${proxy}/control/leases/job`,{method:'DELETE',headers:control});
  await upstreamClosed;
});
test('task tools can reach only their project through the fixed daemon bridge', async () => {
  let forwarded = '';
  const daemon = await listen(createServer((req,res) => {forwarded = `${req.url}:${req.headers.authorization}`; res.end('{}');}));
  const proxy = await listen(createCompanyModelProxy({controlSecret:'control-secret',daemonOrigin:daemon}));
  await fetch(`${proxy}/control/leases`,{method:'POST',headers:{authorization:'Bearer control-secret','content-type':'application/json'},body:JSON.stringify({id:'job',projectId:'own',token:'task',agentId:'codex',model:'m',baseUrl:'https://example.test/v1',apiKey:'secret',protocol:'openai',expiresAt:Date.now()+60000})});
  const headers = {authorization:'Bearer task'};
  expect((await fetch(`${proxy}/od/api/projects/other/files`,{headers})).status).toBe(403);
  expect((await fetch(`${proxy}/od/api/app-config`,{headers})).status).toBe(403);
  expect((await fetch(`${proxy}/od/api/projects/own/files`,{headers})).status).toBe(200);
  expect(forwarded).toBe('/api/projects/own/files:Bearer task');
});

test('native Messages metadata and query survive while task credentials are replaced', async () => {
  let incoming: import('node:http').IncomingHttpHeaders = {}; let url = '';
  const upstream = await listen(createServer((req, res) => { incoming = req.headers; url = req.url!; res.end('{}'); }));
  const proxy = await listen(createCompanyModelProxy({controlSecret:'control-secret'}));
  await fetch(`${proxy}/control/leases`, {method:'POST', headers:{authorization:'Bearer control-secret','content-type':'application/json'}, body:JSON.stringify({id:'native',token:'task',agentId:'claude',model:'m',baseUrl:upstream,apiKey:'real-private',protocol:'anthropic',wireProtocol:'anthropic-messages',expiresAt:Date.now()+60000})});
  const metadata = {'user-agent':'claude-cli/test', 'x-app':'cli', 'x-stainless-lang':'js', 'x-stainless-runtime-version':'v24', 'x-stainless-retry-count':'0', 'x-claude-code-session-id':'test-session', 'anthropic-dangerous-direct-browser-access':'true', 'anthropic-version':'2023-06-01','anthropic-beta':'native-beta'};
  await fetch(`${proxy}/v1/messages?beta=true`, {method:'POST', headers:{...metadata,authorization:'Bearer task','x-api-key':'task','content-type':'application/json',cookie:'session=private','x-control-secret':'private','x-stainless-unknown':'private'}, body:'{"model":"m"}'});
  expect(url).toBe('/messages?beta=true');
  expect(incoming).toMatchObject({...metadata,'x-api-key':'real-private'});
  for (const header of ['authorization','cookie','x-control-secret','x-stainless-unknown']) expect(incoming[header]).toBeUndefined();
});

test.each([
  ['codex', 'openai', 'responses', '/v1/responses', 'max_output_tokens'],
  ['claude', 'anthropic', 'anthropic-messages', '/v1/messages', 'max_tokens'],
  ['opencode', 'openai', 'chat-completions', '/v1/chat/completions', 'max_tokens'],
  ['deepseek-harness', 'openai', 'chat-completions', '/v1/chat/completions', 'max_completion_tokens'],
])('applies the configured output cap to native %s requests without raising smaller budgets', async (agentId, protocol, wireProtocol, pathname, field) => {
  const bodies: Record<string, unknown>[] = [];
  const upstream = await listen(createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw)); res.end('{}');
  }));
  const proxy = await listen(createCompanyModelProxy({ controlSecret: 'control' }));
  const headers = { authorization: 'Bearer task', 'content-type': 'application/json' };
  const lease = { id:'job', token:'task', agentId, model:'m', baseUrl:upstream, apiKey:'private', protocol, wireProtocol, maxTokens:12000, expiresAt:Date.now()+60000 };
  expect((await fetch(`${proxy}/control/leases`, { method:'POST', headers:{...headers, authorization:'Bearer control'}, body:JSON.stringify(lease) })).status).toBe(201);
  for (const budget of [20000, 2048, undefined]) {
    const body = { model:'m', ...(budget === undefined && field !== 'max_completion_tokens' ? {} : { [field]:budget ?? 20000 }) };
    expect((await fetch(proxy+pathname, { method:'POST', headers, body:JSON.stringify(body) })).status).toBe(200);
  }
  expect(bodies.map(body => body[field])).toEqual([12000, 2048, 12000]);
  if (field === 'max_completion_tokens') expect(bodies.every(body => !('max_tokens' in body))).toBe(true);
});
