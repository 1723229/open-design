import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { createChatRunService } from '../../src/runtimes/runs.js';
import { reconcileDurableRunTerminals } from '../../src/runtimes/run-terminal-reconciliation.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
function services(directory: string, preserveQueuedRun?: (id: string) => boolean) {
  return createChatRunService({
    runsLogDir: directory, preserveQueuedRun,
    createSseResponse: () => ({ send() {}, end() {}, cleanup() {} }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
  } as never);
}

it('preserves persistent queue admission while interrupting a previously running child', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-restart-'));
  try {
    const initial = services(directory);
    const queued = initial.create({ projectId: 'p1', agentId: 'codex' });
    const running = initial.create({ projectId: 'p2', agentId: 'codex' });
    running.status = 'running';
    initial.persistState(running);
    const restarted = services(directory, (id) => id === queued.id);
    expect(restarted.get(queued.id)?.status).toBe('queued');
    expect(restarted.get(running.id)?.status).toBe('canceled');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it('keeps admitted queued runs durable during graceful shutdown while cancelling other active runs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-graceful-restart-'));
  const admitted = new Set<string>();
  try {
    const initial = services(directory, (id) => admitted.has(id));
    const queued = initial.create({ projectId: 'p1', agentId: 'codex' });
    admitted.add(queued.id);
    const running = initial.create({ projectId: 'p2', agentId: 'codex' });
    running.status = 'running';
    initial.persistState(running);
    const unadmitted = initial.create({ projectId: 'p3', agentId: 'codex' });

    await initial.shutdownActive({ graceMs: 1 });

    expect(queued.status).toBe('queued');
    expect(queued.cancelRequested).toBeFalsy();
    expect(running.status).toBe('canceled');
    expect(unadmitted.status).toBe('canceled');
    const restarted = services(directory, (id) => admitted.has(id));
    expect(restarted.get(queued.id)?.status).toBe('queued');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it('does not settle a queued assistant or strategy while global restart reconciliation runs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-reconcile-'));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY,run_id TEXT,run_status TEXT,ended_at INTEGER,cancel_origin TEXT,events_json TEXT)');
    const run = services(directory).create({ projectId: 'p1', agentId: 'codex' });
    db.prepare("INSERT INTO messages(id,run_id,run_status) VALUES ('m',?,'queued')").run(run.id);
    const result = await reconcileDurableRunTerminals({
      db, runsLogDir: directory, preserveQueuedRun: (id: string) => id === run.id,
      analytics: { capture: () => {} }, reportLangfuse: () => ({}),
    } as never);
    expect(result.interrupted).toBe(0);
    expect(db.prepare("SELECT run_status FROM messages WHERE id='m'").get()).toEqual({ run_status: 'queued' });
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
