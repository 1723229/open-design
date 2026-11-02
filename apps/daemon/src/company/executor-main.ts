import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildCompanyContainerInvocation, clearCompanyStagedPrompts, companyProjectHome } from './container-execution.js';
import { createCompanyExecutorServer } from './executor-server.js';
import { COMPANY_DOCKER_ENV, executeCompanyDocker, removeCompanyContainers } from './executor-docker.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const config = {
  dataRoot: fs.realpathSync(required('OD_DATA_DIR')),
  image: required('OD_COMPANY_JOB_IMAGE'),
  network: required('OD_COMPANY_JOB_NETWORK'),
  proxyOrigin: required('OD_COMPANY_PROXY_URL'),
};

async function stop(executionId: string): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(executionId)) throw new Error('Invalid execution id');
  await removeCompanyContainers([`nexus-design-job-${executionId}`]);
}

async function reset(): Promise<void> {
  const { stdout } = await executeCompanyDocker(['ps', '-aq', '--filter=label=io.opendesign.company-job=1', `--filter=network=${config.network}`]);
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  await removeCompanyContainers(ids);
  clearCompanyStagedPrompts(config.dataRoot);
}

async function stopJob(jobId: string): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(jobId)) throw new Error('Invalid job id');
  const { stdout } = await executeCompanyDocker(['ps', '-aq', `--filter=label=io.opendesign.company-job-id=${jobId}`, `--filter=network=${config.network}`]);
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  await removeCompanyContainers(ids);
}

await reset();
const server = createCompanyExecutorServer({
  secret: required('OD_COMPANY_EXECUTOR_SECRET'), stop, stopJob, reset,
  launch(request, completeInput) {
    // Validate every mount before creating any file on behalf of the request.
    buildCompanyContainerInvocation(config, { ...request, stdinFile: undefined });
    let stdinFile: string | undefined;
    if (completeInput !== undefined) {
      const staging = path.join(companyProjectHome(config.dataRoot, request.projectId), '.company-stdin');
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(staging) !== staging) throw new Error('Redirected prompt staging directory');
      stdinFile = path.join(staging, request.executionId);
      fs.writeFileSync(stdinFile, completeInput, { flag: 'wx', mode: 0o600 });
    }
    const invocation = buildCompanyContainerInvocation(config, { ...request, stdinFile });
    const child = spawn(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], env: COMPANY_DOCKER_ENV });
    const cleanup = () => { if (stdinFile) fs.rmSync(stdinFile, { force: true }); };
    child.once('close', cleanup);
    child.once('error', cleanup);
    return child;
  },
});
server.listen(Number(process.env.OD_COMPANY_EXECUTOR_PORT ?? 7457), '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { server.close(); void reset().finally(() => process.exit(0)); });
}
