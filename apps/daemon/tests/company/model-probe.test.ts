import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { createCompanyModelProxy, registerCompanyModelLease } from '../../src/company/model-proxy.js';
import { CompanyModelSettings, COMPANY_MODEL_AGENTS } from '../../src/company/model-settings.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeModel, catalogModels } from '../../src/company/model-probe.js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of close.splice(0)) await f(); });
async function upstream(handler: (url: string, body: Record<string, unknown>, res: ServerResponse, headers: IncomingHttpHeaders) => void) {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    handler(req.url!, body ? JSON.parse(body) : {}, res, req.headers);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  close.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
function events(res: ServerResponse, data: unknown[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const bytes = data.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
  for (let i = 0; i < bytes.length; i += 7) res.write(bytes.slice(i, i + 7));
  res.end();
}
const completedStreams = [
  { protocol: 'responses', frames: [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'nexus_probe', arguments: '{}' } },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{}' },
    { type: 'response.completed' },
  ], invalid: { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{invalid' } },
  { protocol: 'chat-completions', frames: [
    { choices: [{ delta: { tool_calls: [{ function: { name: 'nexus_probe', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ], invalid: { choices: [{ delta: { tool_calls: [{ function: { arguments: '{invalid' } }] } }] } },
  { protocol: 'anthropic-messages', frames: [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'nexus_probe', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ], invalid: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{invalid' } } },
] as const;
function streamFetch(frames: readonly unknown[], cancel: () => void, closeBody = false): typeof fetch {
  return async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      if (closeBody) controller.close();
    },
    cancel,
  }), { headers: { 'content-type': 'text/event-stream' } });
}
describe('protocol capability probes', () => {
  it.each(['anthropic', 'google'] as const)('reuses original %s model discovery authentication and envelope', async protocol => {
    const baseUrl = await upstream((url, _body, res, headers) => {
      const parsed = new URL(url, 'http://localhost');
      const valid = protocol === 'anthropic'
        ? headers['x-api-key'] === 'private' && headers['anthropic-version'] === '2023-06-01' && !headers.authorization && parsed.searchParams.get('limit') === '1000'
        : parsed.searchParams.get('key') === 'private' && !headers.authorization;
      res.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(protocol === 'anthropic' ? { data: [{ id: 'claude-model', display_name: 'Claude' }] }
        : { models: [{ name: 'models/gemini-model', displayName: 'Gemini', supportedGenerationMethods: ['generateContent'] }] }));
    });
    expect(await catalogModels({ baseUrl, apiKey: 'private', protocol })).toEqual({ models: [protocol === 'anthropic' ? 'claude-model' : 'gemini-model'] });
  });
  it('bounds model catalog reads without Content-Length and cancels hanging bodies', async () => {
    let flood = false;
    const baseUrl = await upstream((_url, _body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write(flood ? 'x'.repeat(1_100_000) : '{'); });
    await expect(catalogModels({ baseUrl, apiKey: 'private', timeoutMs: 35 })).rejects.toThrow(/catalog/i);
    flood = true;
    await expect(catalogModels({ baseUrl, apiKey: 'private', timeoutMs: 1000 })).rejects.toThrow(/catalog/i);
  });

  it.each(completedStreams)('finishes and cancels $protocol after its terminal event while the body stays open', async ({ protocol, frames }) => {
    let canceled = false;
    const result = await probeModel({ baseUrl: 'https://provider.example/v1', apiKey: 'private', model: 'm', protocol, timeoutMs: 200, fetchImpl: streamFetch(frames, () => { canceled = true; }) });
    expect(result.status).toBe('supported');
    expect(canceled).toBe(true);
  });
  it.each(completedStreams)('rejects $protocol when final arguments invalidate a parseable prefix', async ({ protocol, frames, invalid }) => {
    const data = [...frames.slice(0, -1), invalid, frames.at(-1)];
    expect(await probeModel({ baseUrl: 'https://provider.example/v1', apiKey: 'private', model: 'm', protocol, fetchImpl: streamFetch(data, () => {}, true) })).toMatchObject({ status: 'unsupported' });
  });
  it.each(completedStreams)('rejects $protocol truncated before its terminal event', async ({ protocol, frames }) => {
    expect(await probeModel({ baseUrl: 'https://provider.example/v1', apiKey: 'private', model: 'm', protocol, fetchImpl: streamFetch(frames.slice(0, -1), () => {}, true) })).toMatchObject({ status: 'unsupported' });
  });
  it.each(completedStreams)('processes the entire $protocol frame batch and cancels on failure', async ({ protocol, frames }) => {
    let canceled = false;
    const data = [...frames.slice(0, -1), { type: 'error' }, frames.at(-1)];
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(data.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))); },
      cancel() { canceled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
    expect(await probeModel({ baseUrl: 'https://provider.example/v1', apiKey: 'private', model: 'm', protocol, timeoutMs: 200, fetchImpl })).toMatchObject({ status: 'unsupported' });
    expect(canceled).toBe(true);
  });
  it.each(completedStreams)('uses the same native authentication for $protocol probes and leased jobs', async ({ protocol, frames }) => {
    const baseUrl = await upstream((_url, _body, res, headers) => {
      const valid = protocol === 'anthropic-messages'
        ? headers['x-api-key'] === 'private' && headers['anthropic-version'] === '2023-06-01' && !headers.authorization
        : headers.authorization === 'Bearer private' && !headers['x-api-key'] && !headers['anthropic-version'];
      if (!valid) { res.writeHead(401); res.end(); return; }
      events(res, [...frames]);
    });
    expect((await probeModel({ baseUrl, apiKey: 'private', model: 'm', protocol })).status).toBe('supported');
    const server = createCompanyModelProxy({ controlSecret: 'control' });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    close.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await registerCompanyModelLease(origin, 'control', { id: 'job', token: 'scoped', agentId: protocol === 'anthropic-messages' ? 'claude' : 'codex', model: 'm', baseUrl, apiKey: 'private', protocol: protocol === 'anthropic-messages' ? 'anthropic' : 'openai', wireProtocol: protocol, expiresAt: Date.now() + 60_000 });
    const endpoint = protocol === 'responses' ? 'responses' : protocol === 'chat-completions' ? 'chat/completions' : 'messages';
    const response = await fetch(`${origin}/v1/${endpoint}`, { method: 'POST', headers: { authorization: 'Bearer scoped', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', stream: true }) });
    expect(response.status).toBe(200); await response.text();
  });
  it.each(completedStreams)('does not approve $protocol through an extra auth header unavailable to jobs', async ({ protocol, frames }) => {
    const baseUrl = await upstream((_url, _body, res, headers) => {
      const acceptsExtra = protocol === 'anthropic-messages' ? headers.authorization === 'Bearer private' : headers['x-api-key'] === 'private';
      if (!acceptsExtra) { res.writeHead(401); res.end(); return; }
      events(res, [...frames]);
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'probe-auth-'));
    try {
      const store = new CompanyModelSettings(dir);
      let view = store.saveProvider({ expectedRevision: 0, name: 'Gateway', baseUrl, apiKey: 'private', models: ['m'] });
      const providerId = view.providers[0]!.id;
      view = await store.testProvider({ expectedRevision: view.revision, providerId, model: 'm' });
      expect(view.providers[0]!.capabilities.find(c => c.protocol === protocol)?.status).toBe('error');
      const agentId = protocol === 'responses' ? 'codex' : protocol === 'chat-completions' ? 'opencode' : 'claude';
      expect(() => store.activate({ expectedRevision: view.revision, providerId, model: 'm', agentId }, COMPANY_MODEL_AGENTS.map(a => ({ ...a, installed: true })))).toThrow();
      expect(store.view().active).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('uses OpenAI-compatible catalog authentication without unrelated protocol headers', async () => {
    const baseUrl = await upstream((_url, _body, res, headers) => {
      const valid = headers.authorization === 'Bearer private' && !headers['x-api-key'] && !headers['anthropic-version'];
      res.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm' }] }));
    });
    expect(await catalogModels({ baseUrl, apiKey: 'private' })).toEqual({ models: ['m'] });
  });
  it('proves protocol-specific streamed function calls including argument fragments', async () => {
    const baseUrl = await upstream((url, body, res) => {
      expect(body.model).toBe('manual-model'); expect(body.stream).toBe(true); expect(body.tool_choice).toBeTruthy();
      if (url === '/v1/responses') events(res, [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'nexus_probe', arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{' },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '}' },
        { type: 'response.completed' },
      ]);
      else if (url === '/v1/chat/completions') events(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'nexus_', arguments: '{' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'probe', arguments: '}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);
      else events(res, [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'nexus_probe', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ]);
    });
    for (const protocol of ['responses', 'chat-completions', 'anthropic-messages'] as const) {
      expect(await probeModel({ baseUrl, apiKey: 'private', model: 'manual-model', protocol })).toMatchObject({ status: 'supported', protocol });
    }
  });
  it('rejects HTTP200 text, malformed streams, and wrong protocol shapes', async () => {
    const baseUrl = await upstream((_url, _body, res) => events(res, [{ choices: [{ delta: { content: 'nexus_probe {}' } }] }]));
    expect(await probeModel({ baseUrl, apiKey: 'private', model: 'm', protocol: 'responses' })).toMatchObject({ status: 'unsupported' });
  });
  it('does not mistake an unfinished Anthropic tool block placeholder for valid arguments', async () => {
    const baseUrl = await upstream((_url, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'nexus_probe', input: {} } })}\n\n`);
      setTimeout(() => res.end(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{invalid' } })}\n\n`), 10);
    });
    expect(await probeModel({ baseUrl, apiKey: 'private', model: 'm', protocol: 'anthropic-messages' })).toMatchObject({ status: 'unsupported' });
  });
  it.each(['responses', 'chat-completions', 'anthropic-messages'] as const)('waits for %s completion and rejects a valid argument prefix followed by an error', async protocol => {
    const prefix = protocol === 'responses'
      ? { type: 'response.output_item.added', item: { type: 'function_call', name: 'nexus_probe', arguments: '{}' } }
      : protocol === 'chat-completions'
        ? { choices: [{ delta: { tool_calls: [{ function: { name: 'nexus_probe', arguments: '{}' } }] } }] }
        : { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'nexus_probe', input: {} } };
    const baseUrl = await upstream((_url, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(prefix)}\n\n`);
      if (protocol === 'anthropic-messages') res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })}\n\n`);
      setTimeout(() => res.end(`data: ${JSON.stringify({ type: 'error', error: { message: 'private upstream error' } })}\n\n`), 15);
    });
    const result = await probeModel({ baseUrl, apiKey: 'private', model: 'm', protocol });
    expect(result.status).not.toBe('supported');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('rejects a truncated stream even when the tool arguments are valid', async () => {
    const baseUrl = await upstream((_url, _body, res) => events(res, [
      { type: 'response.output_item.done', item: { type: 'function_call', name: 'nexus_probe', arguments: '{}' } },
    ]));
    expect(await probeModel({ baseUrl, apiKey: 'private', model: 'm', protocol: 'responses' })).toMatchObject({ status: 'unsupported' });
  });
  it.each([[404, 'unsupported'], [405, 'unsupported'], [401, 'error'], [429, 'error'], [500, 'error']])('classifies HTTP %s without leaking response secrets', async (status, want) => {
    const baseUrl = await upstream((_url, _body, res) => { res.writeHead(Number(status)); res.end('private-key-and-transcript'); });
    const result = await probeModel({ baseUrl, apiKey: 'private', model: 'm', protocol: 'responses' });
    expect(result.status).toBe(want); expect(JSON.stringify(result)).not.toContain('private');
  });
  it('bounds hanging streams and byte floods', async () => {
    let flood = false;
    const baseUrl = await upstream((_url, _body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(flood ? 'x'.repeat(1_100_000) : ': heartbeat\n\n'); });
    expect(await probeModel({ baseUrl, apiKey: 'private', model: 'm', protocol: 'responses', timeoutMs: 30 })).toMatchObject({ status: 'error' });
    flood = true;
    expect(await probeModel({ baseUrl, apiKey: 'private', model: 'm', protocol: 'responses', timeoutMs: 1000 })).toMatchObject({ status: 'error' });
  });
  it('returns only safe catalog IDs and redacts upstream failures', async () => {
    let fail = false;
    const baseUrl = await upstream((_url, _body, res) => {
      res.writeHead(fail ? 401 : 200, { 'content-type': 'application/json' });
      res.end(fail ? 'private-key' : JSON.stringify({ data: [{ id: ' manual ' }, { id: 'manual' }, { id: '\nsecret' }, { id: 2 }] }));
    });
    expect(await catalogModels({ baseUrl, apiKey: 'private' })).toEqual({ models: ['manual'] });
    fail = true; await expect(catalogModels({ baseUrl, apiKey: 'private' })).rejects.toThrow(/catalog/i);
  });
});
