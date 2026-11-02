import fs from 'node:fs';
import path from 'node:path';
import type { CompanyModelProtocol } from '@open-design/contracts';
import { buildOpenCodeByokProviderConfig } from '../runtimes/byok-opencode.js';

export const COMPANY_JOB_LEASE_MS = 2 * 60 * 60 * 1000;

export interface CompanyExecutionContext {
  projectId: string;
  agentId: string;
  model: string;
  protocol?: CompanyModelProtocol;
  jobId: string;
  token: string;
  expiresAt?: number;
}
export interface CompanyExecutionRequest extends CompanyExecutionContext {
  executionId: string;
  runId?: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinFile?: string | undefined;
}
export interface CompanyExecutorConfig {
  dataRoot: string;
  image: string;
  network: string;
  proxyOrigin: string;
}

function identifier(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(value) || value === '.' || value === '..') {
    throw new Error('Invalid company execution identifier');
  }
  return value;
}

export function companyProjectHome(dataRoot: string, projectId: string): string {
  return path.join(dataRoot, 'agent-homes', identifier(projectId));
}

export function companyProjectEnvironment(dataRoot: string, projectId: string): NodeJS.ProcessEnv {
  const home = companyProjectHome(dataRoot, projectId);
  return {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    DSH_HOME: path.join(home, '.dsh'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    OD_DATA_DIR: dataRoot,
  };
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function exactRealDirectory(expected: string, label: string): string {
  const resolved = fs.realpathSync(expected);
  if (path.resolve(expected) !== resolved || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Company ${label} must be a real directory without redirected ancestors`);
  }
  if (resolved.includes(',') || resolved.includes('\n')) throw new Error(`Invalid company ${label} path`);
  return resolved;
}

/** Called after all owned containers have been stopped, including startup recovery. */
export function clearCompanyStagedPrompts(dataRoot: string): void {
  const homes = path.join(dataRoot, 'agent-homes');
  if (!fs.existsSync(homes)) return;
  exactRealDirectory(homes, 'HOME root');
  for (const entry of fs.readdirSync(homes, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const staging = path.join(homes, entry.name, '.company-stdin');
    const stat = fs.lstatSync(staging, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) { fs.unlinkSync(staging); continue; }
    exactRealDirectory(staging, 'prompt staging');
    if (!within(homes, staging)) throw new Error('Invalid company prompt staging path');
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** The manager never accepts mounts, executables, Docker flags or inherited credentials from jobs. */
export function buildCompanyContainerInvocation(config: CompanyExecutorConfig, request: CompanyExecutionRequest): { command: string; args: string[] } {
  identifier(request.projectId);
  identifier(request.jobId);
  identifier(request.executionId);
  const executables: Record<string, string> = { claude: 'claude', codex: 'codex', opencode: 'opencode', 'deepseek-harness': 'dsh' };
  const executable = executables[request.agentId];
  if (!executable) throw new Error('Company agent is not installed in the execution image');
  if (!request.token || !request.model || !Array.isArray(request.args) || request.args.some((value) => typeof value !== 'string')) {
    throw new Error('Invalid company execution model, token or arguments');
  }
  const dataRoot = exactRealDirectory(config.dataRoot, 'data root');
  const project = exactRealDirectory(path.join(dataRoot, 'projects', request.projectId), 'project');
  const home = exactRealDirectory(companyProjectHome(dataRoot, request.projectId), 'HOME');
  const cwd = fs.realpathSync(request.cwd);
  if (!within(project, cwd)) throw new Error('Agent cwd must stay within its current project');
  const proxy = new URL(config.proxyOrigin);
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') throw new Error('Invalid model proxy origin');
  const protocol = request.protocol ?? 'chat-completions';
  if (!['responses', 'chat-completions', 'anthropic-messages'].includes(protocol)) throw new Error('Invalid company execution protocol');
  const opencode = request.agentId === 'opencode' ? buildOpenCodeByokProviderConfig({
    protocol: protocol === 'anthropic-messages' ? 'anthropic' : 'openai',
    baseUrl: `${proxy.origin}/v1`, apiKey: request.token,
  }, request.model, protocol === 'anthropic-messages' ? undefined : { openaiWireApi: protocol }) : null;
  if (request.agentId === 'opencode' && !opencode) throw new Error('Invalid OpenCode provider configuration');
  const env: Record<string, string> = {
    ...companyProjectEnvironment(dataRoot, request.projectId),
    PATH: '/opt/agents/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: 'production',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    OD_RESOURCE_ROOT: '/app',
    OD_COMPANY_AGENT_MODEL: request.model,
    OD_COMPANY_TASK_TOKEN: request.token,
    OD_TOOL_TOKEN: request.token,
    OD_DAEMON_URL: `${proxy.origin}/od`,
    OD_API_TOKEN: request.token,
    OD_PROJECT_ID: request.projectId,
    OD_PROJECT_DIR: project,
    OD_STOCK_RUN_ID: request.runId ?? request.executionId,
    OD_NODE_BIN: '/usr/local/bin/node',
    OD_BIN: '/app/apps/daemon/dist/cli.js',
    DSH_PERMISSION_MODE: 'danger-full-access',
    ANTHROPIC_BASE_URL: proxy.origin,
    ANTHROPIC_API_KEY: request.token,
    ANTHROPIC_AUTH_TOKEN: request.token,
    ANTHROPIC_MODEL: request.model,
    OPENAI_BASE_URL: `${proxy.origin}/v1`,
    OPENAI_API_KEY: request.token,
    DEEPSEEK_BASE_URL: `${proxy.origin}/v1`,
    DEEPSEEK_API_KEY: request.token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    ...(opencode ? { ...opencode.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...opencode.config, model: opencode.modelId, permission: 'allow' }) } : {}),
  } as Record<string, string>;
  const agentArgs = [...request.args];
  if (request.stdinFile) {
    if (request.stdinFile !== path.join(home, '.company-stdin', request.executionId)) throw new Error('Invalid staged prompt');
    env.OD_COMPANY_STDIN_FILE = request.stdinFile;
  }
  if (opencode) {
    const modelAt = agentArgs.findIndex((value) => value === '--model' || value === '-m');
    if (modelAt >= 0) agentArgs[modelAt + 1] = opencode.modelId;
  }
  const args = [
    'run', '--rm', '-i', '--init', '--pull=never', `--name=nexus-design-job-${request.executionId}`,
    '--label=io.opendesign.company-job=1', `--label=io.opendesign.company-job-id=${request.jobId}`,
    '--user=1001:1001', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=2g', '--cpus=2', `--network=${config.network}`,
    '--tmpfs=/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount', `type=bind,src=${project},dst=${project}`,
    '--mount', `type=bind,src=${home},dst=${home}`,
    '--workdir', cwd,
  ];
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
  args.push(config.image, executable, ...agentArgs);
  return { command: 'docker', args };
}
