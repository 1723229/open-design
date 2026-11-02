import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnAgentProcessRequest } from '../runtimes/agent-process.js';
import type { CompanyBridgeRequest } from './executor-client.js';

export function prepareCompanyAgentBridge(request: SpawnAgentProcessRequest): { request: SpawnAgentProcessRequest; cleanup(): void } {
  if (!request.company) throw new Error('Missing company execution context');
  const url = process.env.OD_COMPANY_EXECUTOR_URL;
  const secret = process.env.OD_COMPANY_EXECUTOR_SECRET;
  if (!url || !secret) throw new Error('Company executor is unavailable');
  fs.mkdirSync(request.runDir, { recursive: true });
  const executionId = `${request.runId}-${randomUUID().slice(0, 8)}`;
  const config: CompanyBridgeRequest = {
    url, secret,
    execution: {
      ...request.company, executionId, runId: request.runId, args: [...request.args], cwd: request.cwd, env: {},
      inputMode: typeof request.stdin === 'object' ? 'complete' : 'stream',
    },
  };
  const file = path.join(request.runDir, `executor-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  const cleanup = () => fs.rmSync(file, { force: true });
  return {
    request: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./executor-client-main.js', import.meta.url)), file],
      env: { PATH: process.env.PATH }, cwd: request.cwd, stdin: request.stdin, runDir: request.runDir, runId: request.runId,
    },
    cleanup,
  };
}

export async function resetCompanyExecutions(): Promise<void> {
  const response = await fetch(new URL('/reset', process.env.OD_COMPANY_EXECUTOR_URL), {
    method: 'POST', headers: { authorization: `Bearer ${process.env.OD_COMPANY_EXECUTOR_SECRET}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Unable to reconcile company executor: HTTP ${response.status}`);
}

export async function cancelCompanyJob(jobId: string): Promise<void> {
  const response = await fetch(new URL(`/jobs/${encodeURIComponent(jobId)}`, process.env.OD_COMPANY_EXECUTOR_URL), {
    method: 'DELETE', headers: { authorization: `Bearer ${process.env.OD_COMPANY_EXECUTOR_SECRET}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Unable to stop company job: HTTP ${response.status}`);
}
