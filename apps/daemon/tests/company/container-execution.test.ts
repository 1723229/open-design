import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCompanyContainerInvocation, companyProjectHome } from '../../src/company/container-execution.js';
import * as containerExecution from '../../src/company/container-execution.js';

const scratch: string[] = [];
function fixture() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'company-container-'));
  scratch.push(dataRoot);
  const project = path.join(dataRoot, 'projects', 'p1');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(companyProjectHome(dataRoot, 'p1'), { recursive: true });
  return {
    config: { dataRoot, image: 'nexus-agent:pinned', network: 'company-jobs', proxyOrigin: 'http://model-proxy:7458' },
    request: {
      executionId: 'run-1', jobId: 'job-1', projectId: 'p1', agentId: 'claude', model: 'model-a', token: 'job-token',
      args: ['-p', '--output-format', 'stream-json'], cwd: project,
      env: { AWS_SECRET_ACCESS_KEY: 'global-secret', OD_COMPANY_EXECUTOR_SECRET: 'manager-secret', ANTHROPIC_API_KEY: 'real-key' },
    },
  };
}
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('isolated company agent containers', () => {
  it('removes stale staged prompts while retaining project files and CLI state', () => {
    const { config, request } = fixture();
    const home = companyProjectHome(config.dataRoot, 'p1');
    const staging = path.join(home, '.company-stdin');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'interrupted-run'), 'private prompt');
    fs.writeFileSync(path.join(home, 'session-state'), 'retained');
    fs.writeFileSync(path.join(request.cwd, 'index.html'), 'retained project');
    const clear = Reflect.get(containerExecution, 'clearCompanyStagedPrompts');
    expect(clear).toBeTypeOf('function');
    clear(config.dataRoot);
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.readFileSync(path.join(home, 'session-state'), 'utf8')).toBe('retained');
    expect(fs.readFileSync(path.join(request.cwd, 'index.html'), 'utf8')).toBe('retained project');
  });

  it('does not follow redirected HOME or staging directories during prompt cleanup', () => {
    const { config } = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'company-outside-'));
    scratch.push(outside);
    fs.mkdirSync(path.join(outside, '.company-stdin'));
    fs.writeFileSync(path.join(outside, '.company-stdin', 'retained'), 'outside');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(outside, path.join(companyProjectHome(config.dataRoot, 'p1'), '.company-stdin'), linkType);
    fs.symlinkSync(outside, companyProjectHome(config.dataRoot, 'p2'), linkType);
    const clear = Reflect.get(containerExecution, 'clearCompanyStagedPrompts');
    expect(clear).toBeTypeOf('function');
    clear(config.dataRoot);
    expect(fs.readFileSync(path.join(outside, '.company-stdin', 'retained'), 'utf8')).toBe('outside');
    expect(fs.lstatSync(companyProjectHome(config.dataRoot, 'p2')).isSymbolicLink()).toBe(true);
  });

  it.each([
    ['responses', '@ai-sdk/openai'],
    ['chat-completions', '@ai-sdk/openai-compatible'],
    ['anthropic-messages', '@ai-sdk/anthropic'],
  ] as const)('uses the original BYOK profile for pinned OpenCode %s jobs', (protocol, npm) => {
    const { config, request } = fixture();
    const { args } = buildCompanyContainerInvocation(config, {
      ...request, agentId: 'opencode', protocol, args: ['run', '-m', 'model-a'],
    });
    const profile = JSON.parse(args.find(a => a.startsWith('OPENCODE_CONFIG_CONTENT='))!.slice('OPENCODE_CONFIG_CONTENT='.length));
    expect(profile).toMatchObject({ provider: { 'open-design-byok': {
      npm, options: { baseURL: 'http://model-proxy:7458/v1', apiKey: '{env:OPEN_DESIGN_BYOK_API_KEY}' },
      models: { 'model-a': { modalities: { input: ['text', 'image'], output: ['text'] } } },
    } }, model: 'open-design-byok/model-a', permission: 'allow' });
    expect(args).toContain('OPEN_DESIGN_BYOK_API_KEY=job-token');
    expect(args.at(-1)).toBe('open-design-byok/model-a');
    expect(args.join(' ')).not.toContain('real-key');
  });

  it('launches non-root with only the current project and HOME writable, and no inherited credentials', () => {
    const { config, request } = fixture();
    const { command, args } = buildCompanyContainerInvocation(config, request);
    expect(command).toBe('docker');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--user=1001:1001');
    expect(args).toContain('--network=company-jobs');
    const mounts = args.filter((_, index) => args[index - 1] === '--mount');
    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toContain(path.join(config.dataRoot, 'projects', 'p1'));
    expect(mounts[1]).toContain(path.join(config.dataRoot, 'agent-homes', 'p1'));
    expect(args.join(' ')).not.toMatch(/global-secret|manager-secret|real-key|docker\.sock|app\.sqlite/);
    expect(args).toContain('ANTHROPIC_API_KEY=job-token');
    expect(args.at(-4)).toBe('claude');
  });

  it('rejects traversal, unknown agents, and a cwd belonging to another project', () => {
    const { config, request } = fixture();
    expect(() => companyProjectHome(config.dataRoot, '../p2')).toThrow();
    expect(() => buildCompanyContainerInvocation(config, { ...request, agentId: 'qwen' })).toThrow(/agent/);
    expect(() => buildCompanyContainerInvocation(config, { ...request, cwd: config.dataRoot })).toThrow(/project/);
  });

  it('rejects a project root redirected through a symlink', () => {
    const { config, request } = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'company-outside-'));
    scratch.push(outside);
    const linked = path.join(config.dataRoot, 'projects', 'p2');
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => buildCompanyContainerInvocation(config, { ...request, projectId: 'p2', cwd: linked })).toThrow(/project/);
  });
});
