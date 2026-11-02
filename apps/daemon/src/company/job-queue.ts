import { randomUUID } from 'node:crypto';

/** Both the app's better-sqlite3 handle and Node's SQLite test handle implement this boundary. */
export interface QueueDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...parameters: any[]): { changes: number | bigint };
    get(...parameters: any[]): unknown;
    all(...parameters: any[]): unknown[];
  };
}

export type CompanyJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type CompanyJobTerminalState = Exclude<CompanyJobState, 'queued' | 'running'>;
export interface CompanyJob {
  id: string;
  userId: string;
  projectId: string;
  clientRequestId: string;
  payload: Record<string, unknown>;
  state: CompanyJobState;
  runId: string | null;
  createdAt: number;
  updatedAt: number;
}

function decode(row: unknown): CompanyJob | null {
  if (!row) return null;
  const value = row as Omit<CompanyJob, 'payload'> & { payload: string };
  return { ...value, payload: JSON.parse(value.payload) as Record<string, unknown> };
}

/** A lease represents an entire logical turn, including its follow-on physical runs. */
export class CompanyJobQueue {
  constructor(private readonly db: QueueDatabase, private readonly limits = { global: 12, perUser: 3, perProject: 1 }) {
    if (!Number.isSafeInteger(limits.global) || limits.global < 1 || limits.global > 12
      || !Number.isSafeInteger(limits.perUser) || limits.perUser < 1 || limits.perUser > limits.global || limits.perProject !== 1) {
      throw new Error('Company job limits require global 1–12, perUser 1–global and perProject 1');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS company_jobs (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        clientRequestId TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled','interrupted')),
        runId TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        UNIQUE (userId, clientRequestId)
      );
      CREATE INDEX IF NOT EXISTS company_jobs_pending ON company_jobs(state, createdAt);
    `);
  }

  enqueue(input: Pick<CompanyJob, 'userId' | 'projectId' | 'clientRequestId' | 'payload'>): { job: CompanyJob; created: boolean } {
    if (!input.userId || !input.projectId || !input.clientRequestId || input.clientRequestId.length > 200) {
      throw new Error('A user, project and clientRequestId (up to 200 characters) are required');
    }
    const id = randomUUID();
    const now = Date.now();
    const result = this.db.prepare(`INSERT INTO company_jobs
      (id,userId,projectId,clientRequestId,payload,state,createdAt,updatedAt)
      VALUES (?,?,?,?,?,'queued',?,?) ON CONFLICT(userId,clientRequestId) DO NOTHING`)
      .run(id, input.userId, input.projectId, input.clientRequestId, JSON.stringify(input.payload), now, now);
    const job = decode(this.db.prepare('SELECT * FROM company_jobs WHERE userId=? AND clientRequestId=?')
      .get(input.userId, input.clientRequestId))!;
    if (job.projectId !== input.projectId) throw new Error('clientRequestId already belongs to another project');
    return { job, created: Number(result.changes) === 1 };
  }

  get(id: string): CompanyJob | null {
    return decode(this.db.prepare('SELECT * FROM company_jobs WHERE id=?').get(id));
  }

  list(userId?: string): CompanyJob[] {
    const rows = userId
      ? this.db.prepare('SELECT * FROM company_jobs WHERE userId=? ORDER BY createdAt,rowid').all(userId)
      : this.db.prepare('SELECT * FROM company_jobs ORDER BY createdAt,rowid').all();
    return rows.map((row) => decode(row)!);
  }

  claimNext(): CompanyJob | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next = decode(this.db.prepare(`SELECT queued.* FROM company_jobs queued
        WHERE queued.state='queued'
          AND (SELECT COUNT(*) FROM company_jobs WHERE state='running') < ?
          AND (SELECT COUNT(*) FROM company_jobs active WHERE active.state='running'
            AND active.userId=queued.userId) < ?
          AND NOT EXISTS (SELECT 1 FROM company_jobs active WHERE active.state='running'
            AND active.projectId=queued.projectId)
        ORDER BY queued.createdAt,queued.rowid LIMIT 1`).get(this.limits.global, this.limits.perUser));
      if (next) {
        this.db.prepare("UPDATE company_jobs SET state='running',updatedAt=? WHERE id=? AND state='queued'")
          .run(Date.now(), next.id);
      }
      this.db.exec('COMMIT');
      return next ? this.get(next.id) : null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setRunId(id: string, runId: string): void {
    this.db.prepare("UPDATE company_jobs SET runId=?,updatedAt=? WHERE id=? AND state='running'")
      .run(runId, Date.now(), id);
  }

  finish(id: string, state: CompanyJobTerminalState): void {
    this.db.prepare("UPDATE company_jobs SET state=?,updatedAt=? WHERE id=? AND state IN ('queued','running')")
      .run(state, Date.now(), id);
  }

  recoverInterrupted(): number {
    return Number(this.db.prepare("UPDATE company_jobs SET state='interrupted',updatedAt=? WHERE state='running'")
      .run(Date.now()).changes);
  }
}
