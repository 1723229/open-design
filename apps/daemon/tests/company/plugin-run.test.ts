import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock('../../src/agents.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/agents.js')>(),
  detectAgents: async () => [{ id: 'codex', name: 'Codex', bin: 'codex', available: true, authStatus: 'ok', version: 'test' }],
}));

// Vitest runs source modules; the bridge subprocess must use the built Node entry.
vi.mock('../../src/company/agent-bridge.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/company/agent-bridge.js')>();
  return { ...actual, prepareCompanyAgentBridge: (...args: Parameters<typeof actual.prepareCompanyAgentBridge>) => {
    const prepared = actual.prepareCompanyAgentBridge(...args);
    return { ...prepared, request: { ...prepared.request, args: [path.resolve('dist/company/executor-client-main.js'), ...prepared.request.args.slice(1)] } };
  } };
});

let root: string, base: string, cookie: string, csrf: string;
let started: { server: Server; shutdown?: () => Promise<void> | void };
let closeDatabase: () => void;
const servers: Server[] = [];
const executions: Array<{ projectId: string; agentId: string }> = [];

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function request(endpoint: string, body?: unknown) {
  const response = await fetch(base + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: 'http://design.test', 'content-type': 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, data: await response.json() as Record<string, any> };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'company-plugin-run-'));
  vi.stubEnv('OD_DATA_DIR', root);
  vi.stubEnv('OD_ALLOWED_ORIGINS', 'http://design.test');
  vi.stubEnv('OD_CODEX_TRANSPORT', 'exec-json');
  const proxy = await listen(createServer((_req, res) => res.end('{}')));
  const executor = await listen(createServer(async (req, res) => {
    if (req.url !== '/executions') { res.end('{}'); return; }
    let input = '';
    for await (const chunk of req) input += chunk;
    executions.push(JSON.parse(input.split('\n')[0]!));
    const output = [
      { type: 'thread.started', thread_id: `plugin-test-${executions.length}` },
      { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'Plugin context received.' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
    ].map(event => JSON.stringify(event) + '\n').join('');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(JSON.stringify({ type: 'stdout', data: Buffer.from(output).toString('base64') }) + '\n' + JSON.stringify({ type: 'exit', code: 0 }) + '\n');
  }));
  vi.stubEnv('OD_COMPANY_PROXY_URL', proxy);
  vi.stubEnv('OD_COMPANY_PROXY_CONTROL_SECRET', 'plugin-proxy-control');
  vi.stubEnv('OD_COMPANY_EXECUTOR_URL', executor);
  vi.stubEnv('OD_COMPANY_EXECUTOR_SECRET', 'plugin-executor-control');
  await writeFile(path.join(root, 'company.yaml'), 'authentication:\n  enabled: true\n  default_provider: local\nserver:\n  public_origin: http://design.test\nteams:\n  enabled: true\n');
  await writeFile(path.join(root, 'app-config.json'), JSON.stringify({ agentId: 'codex', agentModels: { codex: { model: 'test-model' } }, agentCliEnv: { codex: { OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'https://provider.test/v1' } } }));
  const db = await import('../../src/db.js');
  closeDatabase = db.closeDatabase;
  const { CompanyStore } = await import('../../src/company/store.js');
  const store = new CompanyStore(db.openDatabase(process.cwd(), { dataDir: root }));
  const password = 'Plugin-fixture-password-42';
  const admin = store.createAdmin(password);
  const member = store.createLocalUser('plugin-member', password, 'member', admin.id);
  store.changePassword(member.id, password);
  const { startServer } = await import('../../src/server.js');
  const server = await startServer({ port: 0, host: '127.0.0.1', returnServer: true }) as typeof started & { url: string };
  started = server; base = server.url;
  const login = await request('/api/company/auth/login', { username: 'plugin-member', password });
  expect(login.response.status).toBe(200);
  cookie = login.response.headers.get('set-cookie')!.split(';')[0]!;
  csrf = login.data.csrfToken;
}, 60_000);

afterAll(async () => {
  await started?.shutdown?.();
  started?.server.closeAllConnections();
  if (started) await new Promise<void>(resolve => started.server.close(() => resolve()));
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  closeDatabase?.();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it.each([null, 'design-system-agentic', 'design-system-application', 'example-huashu-pentagram-grid'])(
  'executes company conversation and follow-up with plugin = %s', async pluginId => {
  const created = await request('/api/projects', {
    id: `plugin-regression-${pluginId ?? 'none'}`, name: 'Plugin execution regression', metadata: { kind: 'other', ...(pluginId ? { contextPlugins: [{ id: pluginId, title: pluginId }] } : {}) },
  });
  expect(created.response.status, JSON.stringify(created.data)).toBe(200);
  const { project, conversationId } = created.data;
  const submitted = await request('/api/runs', { projectId: project.id, conversationId, message: 'Reply with a short greeting.', companyActorId: 'forged-user' });
  expect(submitted.response.status, JSON.stringify(submitted.data)).toBe(202);
  let status: Record<string, any> = {};
  for (let attempt = 0; attempt < 100; attempt++) {
    status = (await request(`/api/runs/${submitted.data.runId}`)).data;
    if (['succeeded', 'failed', 'canceled'].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  expect(status.error).toBeNull();
  expect(status.status, JSON.stringify(status)).toBe('succeeded');
  expect(executions).toContainEqual(expect.objectContaining({ projectId: project.id, agentId: 'codex' }));
  const followUp = await request('/api/runs', { projectId: project.id, conversationId, message: 'Continue with a short reply.' });
  expect(followUp.response.status, JSON.stringify(followUp.data)).toBe(202);
  for (let attempt = 0; attempt < 100; attempt++) {
    status = (await request(`/api/runs/${followUp.data.runId}`)).data;
    if (['succeeded', 'failed', 'canceled'].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  expect(status.error).toBeNull();
  expect(status.status, JSON.stringify(status)).toBe('succeeded');
}, 30_000);
