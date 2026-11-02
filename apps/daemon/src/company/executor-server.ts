import type { ChildProcess } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { COMPANY_JOB_LEASE_MS, type CompanyExecutionRequest } from './container-execution.js';

export type ExecutorWireRequest = CompanyExecutionRequest & { inputMode?: 'stream' | 'complete' };

export function createCompanyExecutorServer(options: {
  secret: string;
  launch(request: ExecutorWireRequest, completeInput?: Buffer): ChildProcess;
  stop(executionId: string): Promise<void>;
  stopJob?(jobId: string): Promise<void>;
  reset?(): Promise<void>;
}): http.Server {
  if (options.secret.length < 12) throw new Error('Executor requires a private control secret');
  const active = new Map<string, { jobId: string; child: ChildProcess }>();
  const cancelledJobs = new Map<string, number>();
  const cleanupPending = new Set<string>();
  const cleanupRetries = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  const killClient = (id: string) => {
    const child = active.get(id)?.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const server = http.createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${options.secret}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(cleanupPending.size ? 503 : 200).end(cleanupPending.size ? 'recovering' : 'ok'); return; }
    if (req.method === 'POST' && req.url === '/reset' && options.reset) {
      for (const execution of active.values()) cancelledJobs.set(execution.jobId, Date.now() + COMPANY_JOB_LEASE_MS);
      for (const id of active.keys()) killClient(id);
      void options.reset().then(() => { active.clear(); cleanupPending.clear(); res.end('ok'); }, () => res.writeHead(500).end());
      return;
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/executions/')) {
      const id = decodeURIComponent(req.url.slice('/executions/'.length));
      killClient(id);
      void options.stop(id).then(() => { active.delete(id); cleanupPending.delete(id); res.end('ok'); }, () => res.writeHead(500).end());
      return;
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/jobs/') && options.stopJob) {
      const id = decodeURIComponent(req.url.slice('/jobs/'.length));
      cancelledJobs.set(id, Date.now() + COMPANY_JOB_LEASE_MS);
      for (const [executionId, execution] of active) if (execution.jobId === id) killClient(executionId);
      void options.stopJob(id).then(() => {
        for (const [executionId, execution] of active) if (execution.jobId === id) { active.delete(executionId); cleanupPending.delete(executionId); }
        res.end('ok');
      }, () => res.writeHead(500).end());
      return;
    }
    if (req.method !== 'POST' || req.url !== '/executions') { res.writeHead(404).end(); return; }
    let metadata: ExecutorWireRequest | undefined;
    let pending = Buffer.alloc(0);
    let child: ChildProcess | undefined;
    let completeSize = 0;
    const completeChunks: Buffer[] = [];
    let ended = false;
    let completing = false;
    let deadlineExpired = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping: Promise<void> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const send = (event: object) => {
      if (!res.destroyed && !res.write(`${JSON.stringify(event)}\n`)) {
        child?.stdout?.pause(); child?.stderr?.pause();
      }
    };
    res.on('drain',()=>{child?.stdout?.resume();child?.stderr?.resume();});
    const fail = (error: unknown) => {
      send({ type: 'stderr', data: Buffer.from(error instanceof Error ? error.message : 'Execution failed').toString('base64') });
      send({ type: 'exit', code: 1 });
      res.end();
    };
    const reap = () => {
      clearTimeout(deadlineTimer);
      if (!metadata || !active.has(metadata.executionId)) return Promise.resolve();
      killClient(metadata.executionId);
      return stopping ??= options.stop(metadata.executionId).then(() => {
        active.delete(metadata!.executionId);
        cleanupPending.delete(metadata!.executionId);
        if (retryTimer) { clearTimeout(retryTimer); cleanupRetries.delete(retryTimer); retryTimer = undefined; }
        child?.stdout?.resume(); child?.stderr?.resume();
      }, error => {
        stopping = undefined;
        if (!active.has(metadata!.executionId)) return;
        cleanupPending.add(metadata!.executionId);
        if (!closed && !retryTimer) {
          retryTimer = setTimeout(() => {
            cleanupRetries.delete(retryTimer!); retryTimer = undefined;
            void reap().catch(() => {});
          }, 1000);
          retryTimer.unref(); cleanupRetries.add(retryTimer);
        }
        throw error;
      });
    };
    const finish = (code: number, error?: unknown) => {
      if (completing) return;
      completing = true;
      ended = true;
      clearTimeout(deadlineTimer);
      const report = (cleanupError?: unknown) => {
        if (cleanupError) { fail(cleanupError); return; }
        active.delete(metadata!.executionId);
        if (error || deadlineExpired) send({ type: 'stderr', data: Buffer.from(deadlineExpired ? 'Execution deadline exceeded' : String(error)).toString('base64') });
        send({ type: 'exit', code: deadlineExpired ? 124 : code });
        res.end();
      };
      if (code !== 0 || error || deadlineExpired) void reap().then(() => report(), report);
      else report();
    };
    const launch = (completeInput?: Buffer) => {
      if (!metadata || ended || res.destroyed) return;
      try {
        for (const [id, expires] of cancelledJobs) if (expires <= Date.now()) cancelledJobs.delete(id);
        if (cancelledJobs.has(metadata.jobId)) throw new Error('Job has been cancelled');
        if (active.has(metadata.executionId)) throw new Error('Execution already exists');
        if (cleanupPending.size) throw new Error('Executor is recovering unfinished executions');
        const remaining = metadata.expiresAt === undefined ? undefined : metadata.expiresAt - Date.now();
        if (remaining !== undefined && (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2_147_483_647)) throw new Error('Execution deadline expired or invalid');
        child = options.launch(metadata, completeInput);
        active.set(metadata.executionId, { jobId: metadata.jobId, child });
        if (remaining !== undefined) {
          deadlineTimer = setTimeout(() => {
            deadlineExpired = true;
            ended = true;
            void reap().then(() => finish(124), error => finish(1, error));
          }, remaining);
          deadlineTimer.unref();
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
        child.stdout?.on('data', (data: Buffer) => send({ type: 'stdout', data: data.toString('base64') }));
        child.stderr?.on('data', (data: Buffer) => send({ type: 'stderr', data: data.toString('base64') }));
        child.once('error', error => finish(1, error));
        child.once('close', code => finish(code ?? 1));
        child.stdin?.on('error', () => {});
      } catch (error) { ended = true; fail(error); }
    };
    req.on('data', (chunk: Buffer) => {
      if (ended) return;
      if (!metadata) {
        pending = Buffer.concat([pending, chunk]);
        const newline = pending.indexOf(10);
        if (newline < 0) {
          if (pending.length > 1024 * 1024) { ended = true; fail(new Error('Execution request too large')); }
          return;
        }
        try {
          metadata = JSON.parse(pending.subarray(0, newline).toString('utf8')) as ExecutorWireRequest;
          if (!metadata || typeof metadata.executionId !== 'string') throw new Error('Invalid execution request');
          chunk = pending.subarray(newline + 1);
          pending = Buffer.alloc(0);
          if (metadata.inputMode !== 'complete') launch();
        } catch (error) { ended = true; fail(error); return; }
      }
      if (metadata.inputMode === 'complete') {
        completeSize += chunk.length;
        if (completeSize > 16 * 1024 * 1024) { ended = true; fail(new Error('Prompt exceeds 16 MiB')); return; }
        completeChunks.push(chunk);
      } else if (chunk.length && child?.stdin && !child.stdin.write(chunk)) {
        req.pause();
        child.stdin.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (metadata?.inputMode === 'complete') launch(Buffer.concat(completeChunks));
      child?.stdin?.end();
    });
    const stop = () => {
      if (metadata && !ended && active.has(metadata.executionId)) {
        ended = true;
        void reap().catch(() => console.error('[company-executor] unable to stop disconnected execution'));
      }
    };
    req.on('aborted', stop);
    res.on('close', stop);
  });
  server.once('close', () => { closed = true; for (const timer of cleanupRetries) clearTimeout(timer); cleanupRetries.clear(); });
  return server;
}
