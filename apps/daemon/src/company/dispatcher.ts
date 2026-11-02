import { randomBytes } from 'node:crypto';
import { resetCompanyExecutions } from './agent-bridge.js';
import { COMPANY_JOB_LEASE_MS, companyProjectEnvironment, type CompanyExecutionContext } from './container-execution.js';
import { CompanyJobQueue, type CompanyJob, type CompanyJobTerminalState } from './job-queue.js';

export interface CompanyDispatcherOptions {
  queue: CompanyJobQueue;
  authorize(job: CompanyJob): boolean | Promise<boolean>;
  /** Reconstruct a queued run from persisted payload after restart; never replay running jobs. */
  start(job: CompanyJob): Promise<string | void>;
  /** Must observe logical strategy completion, rather than the end of one physical child. */
  terminalState(job: CompanyJob): CompanyJobTerminalState | null;
  createLease(job: CompanyJob, token: string): Promise<Pick<CompanyExecutionContext, 'agentId' | 'model' | 'protocol'>>;
  revokeLease(job: CompanyJob): Promise<void>;
  /** Terminate the job's container and logical run before its slots are released. */
  cancel(job: CompanyJob): Promise<void>;
  reset?(): Promise<void>;
  onError?(job: CompanyJob, error: unknown): void;
}

export class CompanyDispatcher {
  private readonly executions = new Map<string, CompanyExecutionContext>();
  private readonly cancellations = new Set<string>();
  private pumping: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: CompanyDispatcherOptions) {}

  dispatch(input: Pick<CompanyJob, 'userId' | 'projectId' | 'clientRequestId' | 'payload'>): { job: CompanyJob; created: boolean } {
    const result = this.options.queue.enqueue(input);
    if (this.timer) this.runTerminal();
    return result;
  }

  async start(): Promise<void> {
    await (this.options.reset ?? resetCompanyExecutions)();
    for (const job of this.options.queue.list().filter((job) => job.state === 'running')) await this.options.revokeLease(job);
    this.options.queue.recoverInterrupted();
    await this.pump();
    this.timer = setInterval(() => this.runTerminal(), 500);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  executionForProject(projectId: string): CompanyExecutionContext | undefined {
    return this.executions.get(projectId);
  }

  scopedEnvironmentForProject(projectId: string, dataRoot: string): NodeJS.ProcessEnv {
    const execution = this.executions.get(projectId);
    if (!execution) throw new Error('Project has no active company execution lease');
    const proxy = process.env.OD_COMPANY_PROXY_URL;
    if (!proxy) throw new Error('Company model proxy is unavailable');
    return {
      ...companyProjectEnvironment(dataRoot, projectId),
      ANTHROPIC_API_KEY: execution.token, ANTHROPIC_AUTH_TOKEN: execution.token, ANTHROPIC_BASE_URL: proxy,
      ANTHROPIC_MODEL: execution.model,
      OPENAI_API_KEY: execution.token, OPENAI_BASE_URL: `${proxy.replace(/\/$/, '')}/v1`,
      DEEPSEEK_API_KEY: execution.token, DEEPSEEK_BASE_URL: `${proxy.replace(/\/$/, '')}/v1`,
    };
  }

  runTerminal(): void {
    void this.pump().catch((error: unknown) => console.error('[company-dispatcher] queue pump failed', error instanceof Error ? error.message : 'unknown error'));
  }

  pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = this.pumpOnce().finally(() => { this.pumping = null; });
    return this.pumping;
  }

  async cancel(jobId: string): Promise<void> {
    this.cancellations.add(jobId);
    await this.pumping;
    const job = this.options.queue.get(jobId);
    if (!job || !['queued', 'running'].includes(job.state)) { this.cancellations.delete(jobId); return; }
    await this.options.cancel(job);
    await this.release(job, 'cancelled');
    this.cancellations.delete(jobId);
    this.runTerminal();
  }

  private async release(job: CompanyJob, state: CompanyJobTerminalState): Promise<void> {
    await this.options.revokeLease(job);
    if (this.executions.get(job.projectId)?.jobId === job.id) this.executions.delete(job.projectId);
    this.options.queue.finish(job.id, state);
  }

  private async pumpOnce(): Promise<void> {
    const queue = this.options.queue;
    for (const job of queue.list().filter((job) => job.state === 'running')) {
      if (!(await this.options.authorize(job))) {
        await this.options.cancel(job);
        await this.release(job, 'cancelled');
      } else {
        const terminal = this.options.terminalState(job);
        if (terminal) await this.release(job, terminal);
      }
    }
    for (let job = queue.claimNext(); job; job = queue.claimNext()) {
      if (!(await this.options.authorize(job))) {
        await this.options.cancel(job);
        await this.release(job, 'cancelled');
        continue;
      }
      try {
        const token = randomBytes(32).toString('base64url');
        const lease = await this.options.createLease(job, token);
        if (this.cancellations.has(job.id) || !(await this.options.authorize(job)) || queue.get(job.id)?.state !== 'running') {
          await this.options.cancel(job);
          await this.release(job, 'cancelled');
          continue;
        }
        this.executions.set(job.projectId, { projectId: job.projectId, jobId: job.id, ...lease, token, expiresAt: Date.now() + COMPANY_JOB_LEASE_MS });
        const runId = await this.options.start(job);
        if (runId) queue.setRunId(job.id, runId);
        if (this.cancellations.has(job.id) || !(await this.options.authorize(job))) {
          await this.options.cancel(queue.get(job.id)!);
          await this.release(job, 'cancelled');
        }
      } catch (error) {
        try { this.options.onError?.(job, error); }
        finally {
          await this.options.cancel(job);
          await this.release(job, 'failed');
        }
      }
    }
  }
}
