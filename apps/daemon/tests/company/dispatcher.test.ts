import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { CompanyJobQueue, type CompanyJobTerminalState, type QueueDatabase } from '../../src/company/job-queue.js';
import { CompanyDispatcher } from '../../src/company/dispatcher.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (file: string) => QueueDatabase & { close(): void };
};
it('awaits background directory eligibility before starting a queued job', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const queue = new CompanyJobQueue(db);
    let starts=0;
    let cancelledRuns=0;
    const dispatcher = new CompanyDispatcher({queue,authorize:async()=>false,start:async()=>{starts++;},terminalState:()=>null,createLease:async()=>({agentId:'codex',model:'m'}),revokeLease:async()=>{},cancel:async()=>{cancelledRuns++;}});
    const job=dispatcher.dispatch({userId:'u',projectId:'p',clientRequestId:'id',payload:{}}).job;
    await dispatcher.pump();
    expect(starts).toBe(0); expect(queue.get(job.id)?.state).toBe('cancelled');
    expect(cancelledRuns).toBe(1);
  } finally {db.close();}
});

it('keeps a logical lease between physical runs and rejects revoked queued users', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const queue = new CompanyJobQueue(db, { global: 2, perUser: 1, perProject: 1 });
    let terminal: CompanyJobTerminalState | null = null;
    const dispatcher = new CompanyDispatcher({
      queue,
      authorize: (job) => job.userId !== 'revoked',
      createLease: async () => ({ agentId: 'codex', model: 'model-a', protocol: 'responses' }),
      revokeLease: async () => {},
      cancel: async () => {},
      terminalState: () => terminal,
      start: async (job) => {
        expect(dispatcher.executionForProject(job.projectId)).toMatchObject({ jobId: job.id, agentId: 'codex', model: 'model-a', protocol: 'responses' });
        return 'run-1';
      },
    });
    const first = dispatcher.dispatch({ userId: 'a', projectId: 'p1', clientRequestId: '1', payload: {} }).job;
    const next = dispatcher.dispatch({ userId: 'a', projectId: 'p2', clientRequestId: '2', payload: {} }).job;
    const revoked = dispatcher.dispatch({ userId: 'revoked', projectId: 'p3', clientRequestId: '3', payload: {} }).job;
    await dispatcher.pump();
    expect(queue.get(first.id)).toMatchObject({ state: 'running', runId: 'run-1' });
    expect(queue.get(next.id)?.state).toBe('queued');
    expect(queue.get(revoked.id)?.state).toBe('cancelled');
    await dispatcher.pump();
    expect(queue.get(next.id)?.state).toBe('queued');
    terminal = 'completed';
    await dispatcher.pump();
    expect(queue.get(first.id)?.state).toBe('completed');
    expect(queue.get(next.id)?.state).toBe('running');
    expect(dispatcher.executionForProject('p1')).toBeUndefined();
  } finally { db.close(); }
});

it('recovers queued requests while interrupting previous running requests without replay', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const queue = new CompanyJobQueue(db);
    const prior = queue.enqueue({ userId: 'a', projectId: 'p1', clientRequestId: '1', payload: {} }).job;
    queue.claimNext();
    const queued = queue.enqueue({ userId: 'a', projectId: 'p2', clientRequestId: '2', payload: { prompt: 'persisted' } }).job;
    const dispatcher = new CompanyDispatcher({
      queue, authorize: () => true, terminalState: () => null,
      createLease: async () => ({ agentId: 'claude', model: 'm' }), revokeLease: async () => {}, cancel: async () => {},
      reset: async () => {},
      start: async (job) => { expect(job.payload).toEqual({ prompt: 'persisted' }); return 'restored-run'; },
    });
    await dispatcher.start();
    dispatcher.stop();
    expect(queue.get(prior.id)?.state).toBe('interrupted');
    expect(queue.get(queued.id)).toMatchObject({ state: 'running', runId: 'restored-run' });
  } finally { db.close(); }
});

it('cancels a queued request without removing the running lease on the same project', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const queue = new CompanyJobQueue(db);
    const cancelledRunIds: string[] = [];
    const dispatcher = new CompanyDispatcher({
      queue, authorize: () => true, terminalState: () => null,
      createLease: async () => ({ agentId: 'codex', model: 'm' }), start: async () => 'run1',
      cancel: async (job) => { cancelledRunIds.push(job.payload.runId as string); }, revokeLease: async () => {}, reset: async () => {},
    });
    const running = dispatcher.dispatch({ userId: 'u1', projectId: 'p1', clientRequestId: 'a', payload: {} }).job;
    const queued = dispatcher.dispatch({ userId: 'u2', projectId: 'p1', clientRequestId: 'b', payload: { runId: 'queued-run' } }).job;
    await dispatcher.pump();
    await dispatcher.cancel(queued.id);
    expect(queue.get(queued.id)?.state).toBe('cancelled');
    expect(cancelledRunIds).toEqual(['queued-run']);
    expect(dispatcher.executionForProject('p1')?.jobId).toBe(running.id);
  } finally { db.close(); }
});

it('does not start an execution cancelled while model authorization was pending', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const queue = new CompanyJobQueue(db);
    let finishLease!: () => void;
    const lease = new Promise<void>((resolve) => { finishLease = resolve; });
    let starts = 0;
    const dispatcher = new CompanyDispatcher({
      queue, authorize: () => true, terminalState: () => null,
      createLease: async () => { await lease; return { agentId: 'codex', model: 'm' }; },
      start: async () => { starts += 1; return 'run1'; },
      cancel: async () => {}, revokeLease: async () => {}, reset: async () => {},
    });
    const job = dispatcher.dispatch({ userId: 'u1', projectId: 'p1', clientRequestId: 'a', payload: {} }).job;
    const pumping = dispatcher.pump();
    const cancellation = dispatcher.cancel(job.id);
    finishLease();
    await Promise.all([pumping, cancellation]);
    expect(starts).toBe(0);
    expect(queue.get(job.id)?.state).toBe('cancelled');
    expect(dispatcher.executionForProject('p1')).toBeUndefined();
  } finally { db.close(); }
});

it('retains the slot until terminal cleanup succeeds and retries it on the next pump', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const queue = new CompanyJobQueue(db, { global: 1, perUser: 1, perProject: 1 });
    let terminal: CompanyJobTerminalState | null = null;
    let cleanupFails = true;
    const dispatcher = new CompanyDispatcher({
      queue, authorize: () => true, terminalState: () => terminal,
      createLease: async () => ({ agentId: 'codex', model: 'm' }), start: async () => 'run',
      cancel: async () => {}, revokeLease: async () => { if (cleanupFails) throw new Error('executor unavailable'); },
    });
    const first = dispatcher.dispatch({ userId: 'a', projectId: 'p1', clientRequestId: '1', payload: {} }).job;
    const next = dispatcher.dispatch({ userId: 'b', projectId: 'p2', clientRequestId: '2', payload: {} }).job;
    await dispatcher.pump();
    terminal = 'completed';
    await expect(dispatcher.pump()).rejects.toThrow('executor unavailable');
    expect(queue.get(first.id)?.state).toBe('running');
    expect(queue.get(next.id)?.state).toBe('queued');
    cleanupFails = false;
    await dispatcher.pump();
    expect(queue.get(first.id)?.state).toBe('completed');
    expect(queue.get(next.id)?.state).toBe('running');
  } finally { db.close(); }
});
