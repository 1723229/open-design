import { createRequire } from 'node:module';
import type { QueueDatabase } from '../../src/company/job-queue.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanyJobQueue } from '../../src/company/job-queue.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (file: string) => QueueDatabase & { close(): void };
};
const databases: Array<QueueDatabase & { close(): void }> = [];
function queue(limits?: { global: number; perUser: number; perProject: number }) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  return new CompanyJobQueue(db, limits);
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('company logical turn queue', () => {
  it('reports own active tasks and aggregate capacity without returning another user or execution secrets',()=>{
    const q=queue({global:3,perUser:1,perProject:1});
    const own=q.enqueue({userId:'a',projectId:'own',clientRequestId:'one',payload:{runId:'run-own',apiKey:'secret-never-return'}}).job;
    q.enqueue({userId:'a',projectId:'later',clientRequestId:'two',payload:{runId:'run-later'}});
    q.enqueue({userId:'b',projectId:'private-other',clientRequestId:'three',payload:{token:'another-secret'}});
    q.claimNext();q.claimNext();
    const status=q.status('a');
    expect(status).toMatchObject({limits:{global:3,perUser:1,perProject:1},usage:{globalRunning:2,userRunning:1,userQueued:1}});
    expect(status.tasks).toHaveLength(2);
    expect(status.tasks[0]).toMatchObject({jobId:own.id,projectId:'own',runId:'run-own',state:'running'});
    expect(JSON.stringify(status)).not.toMatch(/secret|private-other|payload/u);
    q.finish(own.id,'completed');
    expect(q.status('a').tasks).toHaveLength(1);
  });
  it('defaults to three tasks per user while allowing another user to proceed', () => {
    const q = queue();
    const jobs = ['a', 'a', 'a', 'a', 'b'].map((userId, n) => q.enqueue({
      userId, projectId: `p${n}`, clientRequestId: `${n}`, payload: {},
    }).job);
    for (const job of jobs.slice(0, 3)) expect(q.claimNext()?.id).toBe(job.id);
    expect(q.claimNext()?.id).toBe(jobs[4]!.id);
    expect(q.get(jobs[3]!.id)?.state).toBe('queued');
    expect(q.claimNext()).toBeNull();
    q.finish(jobs[0]!.id, 'completed');
    expect(q.claimNext()?.id).toBe(jobs[3]!.id);
  });

  it('defaults to twelve global slots shared by users with three slots each', () => {
    const q = queue();
    for (let user = 0; user < 4; user++) for (let n = 0; n < 4; n++) q.enqueue({
      userId: `u${user}`, projectId: `p${user}-${n}`, clientRequestId: `${n}`, payload: {},
    });
    for (let n = 0; n < 12; n++) expect(q.claimNext()).not.toBeNull();
    expect(q.claimNext()).toBeNull();
    for (let user = 0; user < 4; user++) expect(q.list(`u${user}`).filter(j => j.state === 'running')).toHaveLength(3);
  });

  it('admits a configured global capacity above twelve', () => {
    const q = queue({ global: 16, perUser: 16, perProject: 1 });
    const jobs = Array.from({ length: 17 }, (_, n) => q.enqueue({
      userId: 'a', projectId: `p${n}`, clientRequestId: `${n}`, payload: {},
    }).job);
    for (const job of jobs.slice(0, 16)) expect(q.claimNext()?.id).toBe(job.id);
    expect(q.claimNext()).toBeNull();
    expect(q.get(jobs[16]!.id)?.state).toBe('queued');
    q.finish(jobs[0]!.id, 'completed');
    expect(q.claimNext()?.id).toBe(jobs[16]!.id);
  });

  it('serializes a project even with spare global and user capacity', () => {
    const q = queue({ global: 3, perUser: 3, perProject: 1 });
    const first = q.enqueue({ userId: 'a', projectId: 'p1', clientRequestId: '1', payload: {} }).job;
    const sameProject = q.enqueue({ userId: 'a', projectId: 'p1', clientRequestId: '2', payload: {} }).job;
    const independent = q.enqueue({ userId: 'a', projectId: 'p2', clientRequestId: '3', payload: {} }).job;
    expect(q.claimNext()?.id).toBe(first.id);
    q.setRunId(first.id, 'physical-1');
    q.setRunId(first.id, 'physical-2');
    expect(q.claimNext()?.id).toBe(independent.id);
    expect(q.claimNext()).toBeNull();
    q.finish(first.id, 'completed');
    expect(q.claimNext()?.id).toBe(sameProject.id);
  });

  it('skips a user at quota to admit another user in queue order', () => {
    const q = queue({ global: 3, perUser: 2, perProject: 1 });
    const jobs = ['a', 'a', 'a', 'b', 'c'].map((userId, n) => q.enqueue({
      userId, projectId: `p${n}`, clientRequestId: `${n}`, payload: {},
    }).job);
    expect(q.claimNext()?.id).toBe(jobs[0]!.id);
    expect(q.claimNext()?.id).toBe(jobs[1]!.id);
    expect(q.claimNext()?.id).toBe(jobs[3]!.id);
    expect(q.claimNext()).toBeNull();
    q.finish(jobs[0]!.id, 'completed');
    expect(q.claimNext()?.id).toBe(jobs[2]!.id);
  });

  it.each([
    { global: 0, perUser: 1, perProject: 1 },
    { global: 2.5, perUser: 1, perProject: 1 },
    { global: NaN, perUser: 1, perProject: 1 },
    { global: Infinity, perUser: 1, perProject: 1 },
    { global: Number.MAX_SAFE_INTEGER + 1, perUser: 1, perProject: 1 },
    { global: 3, perUser: 0, perProject: 1 },
    { global: 3, perUser: -1, perProject: 1 },
    { global: 3, perUser: 4, perProject: 1 },
    { global: 3, perUser: 1.5, perProject: 1 },
    { global: 3, perUser: NaN, perProject: 1 },
    { global: 3, perUser: Infinity, perProject: 1 },
    { global: 3, perUser: Number.MAX_SAFE_INTEGER + 1, perProject: 1 },
    { global: 3, perUser: 2, perProject: 0 },
    { global: 3, perUser: 2, perProject: 2 },
    { global: 3, perUser: 2, perProject: 1.5 },
  ])('rejects invalid quotas $global/$perUser/$perProject', (limits) => {
    expect(() => queue(limits)).toThrow(/limits/);
  });

  it('deduplicates a user request without replacing its original payload', () => {
    const q = queue();
    const first = q.enqueue({ userId: 'a', projectId: 'p', clientRequestId: 'r', payload: { prompt: 'first' } });
    const retry = q.enqueue({ userId: 'a', projectId: 'p', clientRequestId: 'r', payload: { prompt: 'changed' } });
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.job.id).toBe(first.job.id);
    expect(retry.job.payload).toEqual({ prompt: 'first' });
    expect(() => q.enqueue({ userId: 'a', projectId: 'other', clientRequestId: 'r', payload: {} })).toThrow(/project/);
  });

  it('holds global, user and project slots until a whole logical turn finishes', () => {
    const q = queue({ global: 2, perUser: 1, perProject: 1 });
    const add = (userId: string, projectId: string, clientRequestId: string) =>
      q.enqueue({ userId, projectId, clientRequestId, payload: {} }).job;
    const first = add('a', 'p1', '1');
    const sameUser = add('a', 'p2', '2');
    const sameProject = add('b', 'p1', '3');
    const other = add('c', 'p3', '4');
    expect(q.claimNext()?.id).toBe(first.id);
    expect(q.claimNext()?.id).toBe(other.id);
    expect(q.claimNext()).toBeNull();
    q.finish(first.id, 'completed');
    expect(q.claimNext()?.id).toBe(sameUser.id);
    q.finish(other.id, 'failed');
    expect(q.claimNext()?.id).toBe(sameProject.id);
  });

  it('retains queued work but never automatically replays interrupted work', () => {
    const q = queue();
    const running = q.enqueue({ userId: 'a', projectId: 'p1', clientRequestId: '1', payload: {} }).job;
    const queued = q.enqueue({ userId: 'a', projectId: 'p2', clientRequestId: '2', payload: {} }).job;
    q.claimNext();
    expect(q.recoverInterrupted()).toBe(1);
    expect(q.get(running.id)?.state).toBe('interrupted');
    expect(q.claimNext()?.id).toBe(queued.id);
    expect(q.claimNext()).toBeNull();
  });

  it('cancels queued work and records the physical run without releasing its lease', () => {
    const q = queue();
    const job = q.enqueue({ userId: 'a', projectId: 'p', clientRequestId: '1', payload: {} }).job;
    q.claimNext();
    q.setRunId(job.id, 'run-1');
    expect(q.get(job.id)).toMatchObject({ state: 'running', runId: 'run-1' });
    q.finish(job.id, 'cancelled');
    expect(q.get(job.id)?.state).toBe('cancelled');
    expect(q.list('a')).toHaveLength(1);
    expect(q.list('b')).toEqual([]);
  });

  it('allows a configured global limit above twelve while retaining validation', () => {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    expect(() => new CompanyJobQueue(db, { global: 0, perUser: 1, perProject: 1 })).toThrow();
    const q = new CompanyJobQueue(db, { global: 16, perUser: 1, perProject: 1 });
    for (let n = 0; n < 17; n++) q.enqueue({ userId: `u${n}`, projectId: `p${n}`, clientRequestId: `${n}`, payload: {} });
    for (let n = 0; n < 16; n++) expect(q.claimNext()).not.toBeNull();
    expect(q.claimNext()).toBeNull();
  });
});
