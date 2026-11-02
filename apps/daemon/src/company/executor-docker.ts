import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
// Bound Docker CLI threads on large hosts so control operations fit the PID budget.
export const COMPANY_DOCKER_ENV = { PATH: process.env.PATH, GOMAXPROCS: '2' };

export function executeCompanyDocker(args: string[]) {
  return execute('docker', args, { env: COMPANY_DOCKER_ENV, timeout: 10_000 });
}

/** A concurrent --rm/stop is successful only once Docker confirms removal. */
export async function removeCompanyContainers(
  ids: string[],
  remove: (ids: string[]) => Promise<unknown> = ids => executeCompanyDocker(['rm', '--force', ...ids]),
): Promise<void> {
  if (!ids.length) return;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await remove(ids); return; }
    catch (error) {
      const lines = String((error as { stderr?: string }).stderr ?? '').trim().split(/\r?\n/);
      const removing = /removal of container .+ is already in progress/;
      if (!lines.every(line => line.includes('No such container') || removing.test(line))) throw error;
      if (!lines.some(line => removing.test(line))) return;
      if (attempt === 49) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
