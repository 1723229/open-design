import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createCompanyExecutorServer } from '../../src/company/executor-server.js';
import { relayCompanyExecution } from '../../src/company/executor-client.js';

const servers: ReturnType<typeof createCompanyExecutorServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('preserves output while a slow consumer applies backpressure', async () => {
  let pauses=0;
  const server=createCompanyExecutorServer({secret:'control-secret',stop:async()=>{},launch:()=>{
    const child=spawn(process.execPath,['-e',"process.stdout.write('x'.repeat(512*1024))"]);
    child.stdout.on('pause',()=>pauses++); return child;
  }});
  servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  let bytes=0;
  const sink=new Writable({highWaterMark:1,write(chunk,_encoding,done){setTimeout(()=>{bytes+=chunk.length;done();},3);}});
  const code=await relayCompanyExecution({url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,secret:'control-secret',execution:{executionId:'slow',jobId:'slow',projectId:'p',agentId:'codex',model:'m',token:'t',args:[],cwd:'/project',env:{}}},Readable.from([]),sink,sink);
  expect(code).toBe(0); expect(bytes).toBe(512*1024); expect(pauses).toBeGreaterThan(0);
});

it('relays framed stdin and separate stdout/stderr through the authenticated manager', async () => {
  const server = createCompanyExecutorServer({
    secret: 'control-secret',
    launch: () => spawn(process.execPath, ['-e', "process.stdin.pipe(process.stdout);process.stdin.on('end',()=>process.stderr.write('diagnostic'))"]),
    stop: async () => {},
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  const capture = (buffers: Buffer[]) => new Writable({ write(chunk, _encoding, done) { buffers.push(Buffer.from(chunk)); done(); } });
  const code = await relayCompanyExecution({
    url: origin, secret: 'control-secret',
    execution: { executionId: 'run-1', jobId: 'job-1', projectId: 'p1', agentId: 'claude', model: 'm', token: 't', args: [], cwd: '/project', env: {} },
  }, Readable.from(['{"frame":1}\n', '{"frame":2}\n']), capture(output), capture(errors));
  expect(code).toBe(0);
  expect(Buffer.concat(output).toString()).toBe('{"frame":1}\n{"frame":2}\n');
  expect(Buffer.concat(errors).toString()).toBe('diagnostic');
  expect((await fetch(`${origin}/health`)).status).toBe(401);
});

it('delivers a complete large plain prompt before starting the agent', async () => {
  const server = createCompanyExecutorServer({
    secret: 'control-secret', stop: async () => {},
    launch(_request, completeInput) {
      const child = spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)']);
      child.stdin.write(completeInput);
      return child;
    },
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const prompt = 'x'.repeat(256 * 1024) + 'END';
  const output: Buffer[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { output.push(Buffer.from(chunk)); done(); } });
  const code = await relayCompanyExecution({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, secret: 'control-secret',
    execution: { executionId: 'run-2', jobId: 'job-2', projectId: 'p1', agentId: 'codex', model: 'm', token: 't', args: [], cwd: '/project', env: {}, inputMode: 'complete' },
  }, Readable.from([prompt.slice(0, 64000), prompt.slice(64000)]), sink, sink);
  expect(code).toBe(0);
  expect(Buffer.concat(output).toString()).toBe(prompt);
});

it('aborting a relay rejects its promise and closes a stalled HTTP connection', async () => {
  const { createServer } = await import('node:http');
  let received!: () => void; let closed!: () => void;
  const started = new Promise<void>(r=>{received=r;});
  const disconnected = new Promise<void>(r=>{closed=r;});
  const server = createServer((req,res)=>{req.resume();res.once('close',closed);received();});
  servers.push(server); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const controller = new AbortController();
  const sink = new Writable({write(_chunk,_encoding,done){done();}});
  const relaying = relayCompanyExecution({url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,secret:'control-secret',execution:{executionId:'cancelled',jobId:'probe',projectId:'probe',agentId:'claude',model:'m',token:'scoped',args:[],cwd:'/project',env:{},inputMode:'complete'}}, Readable.from(['complete prompt']),sink,sink,controller.signal);
  const rejected = expect(relaying).rejects.toMatchObject({name:'AbortError'});
  await started; controller.abort(); await rejected; await disconnected;
});

it('rejects a failed executor stop response', async () => {
  const { createServer } = await import('node:http');
  const { stopCompanyExecution } = await import('../../src/company/executor-client.js');
  const server = createServer((_req,res)=>{res.writeHead(500);res.end('failed');});
  servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  await expect(stopCompanyExecution({url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,secret:'control-secret',execution:{executionId:'probe',jobId:'probe',projectId:'probe',agentId:'claude',model:'m',token:'scoped',args:[],cwd:'/project',env:{}}})).rejects.toThrow();
});

it('reaps an abnormal Docker client exit before reporting the execution result', async () => {
  let reaped = false;
  const stop = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 25)); reaped = true; });
  const server = createCompanyExecutorServer({ secret: 'control-secret', stop,
    launch: () => spawn(process.execPath, ['-e', 'process.exit(7)']),
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const code = await relayCompanyExecution({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, secret: 'control-secret',
    execution: { executionId: 'crashed-client', jobId: 'j', projectId: 'p', agentId: 'codex', model: 'm', token: 't', args: [], cwd: '/project', env: {} },
  }, Readable.from([]), sink, sink);
  expect(code).toBe(7);
  expect(stop).toHaveBeenCalledExactlyOnceWith('crashed-client');
  expect(reaped).toBe(true);
});

it('rejects an expired execution before launching a process', async () => {
  const launch = vi.fn(() => spawn(process.execPath, ['-e', 'process.exit(0)']));
  const server = createCompanyExecutorServer({ secret: 'control-secret', launch, stop: async () => {} });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const code = await relayCompanyExecution({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, secret: 'control-secret',
    execution: { executionId: 'expired', jobId: 'j', projectId: 'p', agentId: 'codex', model: 'm', token: 't', args: [], cwd: '/project', env: {}, expiresAt: Date.now() - 1 },
  }, Readable.from([]), sink, sink);
  expect(code).toBe(1);
  expect(launch).not.toHaveBeenCalled();
});

it('enforces a running execution deadline independently of the API connection', async () => {
  let child: ReturnType<typeof spawn> | undefined;
  const stop = vi.fn(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill(); await closed;
    }
  });
  const server = createCompanyExecutorServer({ secret: 'control-secret', stop,
    launch: () => (child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'])),
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const controller = new AbortController();
  const running = relayCompanyExecution({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, secret: 'control-secret',
    execution: { executionId: 'deadline', jobId: 'j', projectId: 'p', agentId: 'codex', model: 'm', token: 't', args: [], cwd: '/project', env: {}, expiresAt: Date.now() + 250 },
  }, Readable.from([]), sink, sink, controller.signal).catch(() => -1);
  try {
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(stop).toHaveBeenCalledExactlyOnceWith('deadline');
    expect(await running).toBe(124);
  } finally { controller.abort(); await stop(); await running; }
});

it('retries a failed cleanup after the relay ends and pauses new launches until recovery', async () => {
  let attempts = 0;
  const stop = vi.fn(async () => { if (++attempts === 1) throw new Error('Docker temporarily unavailable'); });
  const server = createCompanyExecutorServer({ secret: 'control-secret', stop,
    launch: () => spawn(process.execPath, ['-e', 'process.exit(7)']),
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const request = { url, secret: 'control-secret', execution: {
    executionId: 'retry-cleanup', jobId: 'j', projectId: 'p', agentId: 'codex', model: 'm', token: 't', args: [], cwd: '/project', env: {},
  } };
  expect(await relayCompanyExecution(request, Readable.from([]), sink, sink)).toBe(1);
  expect((await fetch(`${url}/health`, { headers: { authorization: 'Bearer control-secret' } })).status).toBe(503);
  expect(await relayCompanyExecution({ ...request, execution: { ...request.execution, executionId: 'blocked-by-cleanup' } }, Readable.from([]), sink, sink)).toBe(1);
  expect(attempts).toBe(1);
  await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 3000 });
  expect((await fetch(`${url}/health`, { headers: { authorization: 'Bearer control-secret' } })).status).toBe(200);
});

it('keeps a confirmed job cleanup healthy when an earlier execution cleanup fails later', async () => {
  let started!: () => void;
  const stopping = new Promise<void>(resolve => { started = resolve; });
  let reject!: (error: Error) => void;
  const server = createCompanyExecutorServer({ secret: 'control-secret',
    launch: () => spawn(process.execPath, ['-e', 'process.exit(7)']),
    stop: () => { started(); return new Promise<void>((_resolve, rejectStop) => { reject = rejectStop; }); },
    stopJob: async () => {},
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const running = relayCompanyExecution({ url, secret: 'control-secret', execution: {
    executionId: 'cleanup-race', jobId: 'j', projectId: 'p', agentId: 'codex', model: 'm', token: 't', args: [], cwd: '/project', env: {},
  } }, Readable.from([]), sink, sink);
  await stopping;
  expect((await fetch(`${url}/jobs/j`, { method: 'DELETE', headers: { authorization: 'Bearer control-secret' } })).status).toBe(200);
  reject(new Error('Earlier cleanup failed'));
  await running;
  expect((await fetch(`${url}/health`, { headers: { authorization: 'Bearer control-secret' } })).status).toBe(200);
});

it('stops a launching Docker client before confirming job cancellation', async () => {
  let child!: ReturnType<typeof spawn>;
  let started!: () => void;
  const launched = new Promise<void>(resolve => { started = resolve; });
  const server = createCompanyExecutorServer({ secret: 'control-secret', stop: async () => {}, stopJob: async () => {},
    launch: () => { child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']); started(); return child; },
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const controller = new AbortController();
  const running = relayCompanyExecution({ url, secret: 'control-secret', execution: {
    executionId: 'starting', jobId: 'j', projectId: 'p', agentId: 'codex', model: 'm', token: 't', args: [], cwd: '/project', env: {},
  } }, Readable.from([]), sink, sink, controller.signal).catch(() => -1);
  try {
    await launched;
    expect((await fetch(`${url}/jobs/j`, { method: 'DELETE', headers: { authorization: 'Bearer control-secret' } })).status).toBe(200);
    expect(child.killed).toBe(true);
  } finally { controller.abort(); child.kill(); await running; }
});

it('rejects a late execution request for a job that has already been cancelled', async () => {
  const launch = vi.fn(() => spawn(process.execPath, ['-e', 'process.exit(0)']));
  const server = createCompanyExecutorServer({ secret: 'control-secret', launch, stop: async () => {}, stopJob: async () => {} });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  expect((await fetch(`${url}/jobs/j`, { method: 'DELETE', headers: { authorization: 'Bearer control-secret' } })).status).toBe(200);
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  expect(await relayCompanyExecution({ url, secret: 'control-secret', execution: {
    executionId: 'late', jobId: 'j', projectId: 'p', agentId: 'codex', model: 'm', token: 't', args: [], cwd: '/project', env: {},
  } }, Readable.from([]), sink, sink)).toBe(1);
  expect(launch).not.toHaveBeenCalled();
});
