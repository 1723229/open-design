import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  fs: {
    mkdirSync: vi.fn(), existsSync: vi.fn(() => true), cpSync: vi.fn(),
    writeFileSync: vi.fn(), realpathSync: vi.fn(() => '/opt/agents/node_modules/dsh/bin/dsh.js'),
    openSync: vi.fn(() => 37), closeSync: vi.fn(), unlinkSync: vi.fn(),
  },
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ default: mocks.fs }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

async function invoke(command: string) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  mocks.spawn.mockReturnValue(child);
  const runtime = {
    ...process, argv: [process.execPath, 'agent-entry.ts', command, '--profile', 'open-design', '--stdio'],
    env: {
      HOME: '/fixture-home', OD_COMPANY_AGENT_MODEL: 'vendor/model',
      DEEPSEEK_BASE_URL: 'https://provider.invalid/v1', OPENAI_BASE_URL: 'https://provider.invalid/v1',
      OD_COMPANY_STDIN_FILE: '/fixture-input',
    },
    on: vi.fn(), exitCode: undefined as number | undefined,
  };
  vi.stubGlobal('process', runtime);
  await import('../../../deploy/company/agent-entry.ts');
  return { child, runtime };
}

test('DSH stdio launches the installed JS bin with the required Node startup flag', async () => {
  const { child, runtime } = await invoke('dsh');
  const patch = path.join('/fixture-home', '.dsh', 'profiles', 'open-design', 'company.patch.yml');
  expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, [
    '--expose-internals', '/opt/agents/node_modules/dsh/bin/dsh.js',
    '--patch', patch, '--profile', 'open-design', '--stdio',
  ], { stdio: [37, 'inherit', 'inherit'], env: runtime.env });
  expect(mocks.fs.realpathSync).toHaveBeenCalledWith('/opt/agents/node_modules/.bin/dsh');
  expect(JSON.parse(mocks.fs.writeFileSync.mock.calls[0]![1])).toEqual([
    { id: 'llm-deepseek', config: {
      baseURL: 'https://provider.invalid/v1', apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'vendor/model', name: 'vendor/model' }],
    } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'vendor/model' } },
  ]);
  expect(mocks.fs.openSync).toHaveBeenCalledWith('/fixture-input', 'r');
  expect(mocks.fs.closeSync).toHaveBeenCalledWith(37);
  expect(mocks.fs.unlinkSync).toHaveBeenCalledWith('/fixture-input');
  for (const [signal, listener] of runtime.on.mock.calls) {
    listener();
    expect(child.kill).toHaveBeenCalledWith(signal);
  }
  child.emit('close', 7);
  expect(runtime.exitCode).toBe(7);
});

test.each(['codex', 'claude', 'opencode'])('%s keeps its existing CLI invocation', async (command) => {
  const { runtime } = await invoke(command);
  expect(mocks.spawn).toHaveBeenCalledWith(command, ['--profile', 'open-design', '--stdio'], {
    stdio: [37, 'inherit', 'inherit'], env: runtime.env,
  });
  expect(mocks.fs.realpathSync).not.toHaveBeenCalled();
});
