import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const command = process.argv[2];
if (!command || !['claude', 'codex', 'opencode', 'dsh'].includes(command)) throw new Error('Unsupported company agent');
const home = process.env.HOME;
if (!home) throw new Error('Missing isolated HOME');
for (const directory of ['.codex', '.config', '.cache', '.local/share', '.dsh']) {
  fs.mkdirSync(path.join(home, directory), { recursive: true, mode: 0o700 });
}
const args = process.argv.slice(3);
if (command === 'codex') {
  // Match the working server's Responses transport. The task token is supplied
  // through the environment; provider credentials never enter this file.
  const configuration = [
    'model_provider = "nexus"',
    `model = ${JSON.stringify(process.env.OD_COMPANY_AGENT_MODEL)}`,
    'suppress_unstable_features_warning = true',
    '[model_providers.nexus]',
    'name = "NexusDesign"',
    `base_url = ${JSON.stringify(process.env.OPENAI_BASE_URL)}`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    'requires_openai_auth = false',
    'supports_websockets = false',
  ].join('\n');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `${configuration}\n`, { mode: 0o600 });
}
if (command === 'dsh') {
  const dshHome = path.join(home, '.dsh');
  const profile = path.join(dshHome, 'profiles', 'open-design');
  if (!fs.existsSync(path.join(profile, 'package.json'))) {
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.cpSync('/opt/company-profile', profile, { recursive: true, verbatimSymlinks: true });
  }
  const model = process.env.OD_COMPANY_AGENT_MODEL!;
  const patch = path.join(profile, 'company.patch.yml');
  // JSON is valid YAML; no prompt/model text is interpreted as configuration syntax.
  fs.writeFileSync(patch, JSON.stringify([
    { id: 'llm-deepseek', config: {
      baseURL: process.env.DEEPSEEK_BASE_URL, apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: model, name: model }],
    } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model } },
  ]));
  // The DSH profile's HMR plugin requires this Node startup flag.
  args.unshift('--expose-internals', fs.realpathSync('/opt/agents/node_modules/.bin/dsh'), '--patch', patch);
}
let input: number | 'inherit' = 'inherit';
if (process.env.OD_COMPANY_STDIN_FILE) input = fs.openSync(process.env.OD_COMPANY_STDIN_FILE, 'r');
const child = spawn(command === 'dsh' ? process.execPath : command, args, { stdio: [input, 'inherit', 'inherit'], env: process.env });
if (typeof input === 'number') {
  fs.closeSync(input);
  fs.unlinkSync(process.env.OD_COMPANY_STDIN_FILE!);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
child.once('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('close', (code) => { process.exitCode = code ?? 1; });
