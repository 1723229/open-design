import { expect, test } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { CompanyModelRoute } from '@open-design/contracts';
import { attachDshProfileSession } from '../../src/agent-protocol/dsh-profile/session.js';
import { parseDshProfileHostCommand } from '../../src/agent-protocol/dsh-profile/frames.js';
import { managedCompanyRunBody, publicCompanyConfig } from '../../src/company/managed-agent.js';
test('administrator configuration replaces caller agent/model and provider credentials', () => {
  const config = {agentId:'codex',agentModels:{codex:{model:'approved',reasoning:'high'}},agentCliEnv:{codex:{OPENAI_API_KEY:'secret'}}};
  const result = managedCompanyRunBody(config,{message:'hi',agentId:'claude',model:'unapproved',byokProvider:{apiKey:'leak'},env:{TOKEN:'evil'}});
  expect(result).toMatchObject({message:'hi',agentId:'codex',model:'approved',reasoning:'high'});
  expect(result).not.toHaveProperty('byokProvider');
  expect(result).not.toHaveProperty('env');
  expect(JSON.stringify(publicCompanyConfig(config))).not.toContain('secret');
});
test('company configuration must have an explicit supported default', () => {
  expect(() => managedCompanyRunBody({agentId:'amr'},{})).toThrow();
  expect(() => managedCompanyRunBody({agentId:'codex'},{})).toThrow();
});

test('an immutable unified route overrides legacy defaults without trusting caller routing', () => {
  const result = managedCompanyRunBody({ agentId: 'codex', agentModels: { codex: { model: 'old' } } }, {
    message: 'hello', agentId: 'opencode', model: 'unapproved',
    companyModelRoute: { providerId: 'attacker', providerRevision: 99 },
  }, { agentId: 'claude', providerId: 'shared', providerRevision: 2, model: 'approved', protocol: 'anthropic-messages' });
  expect(result).toMatchObject({ agentId: 'claude', model: 'approved', message: 'hello' });
  expect(result.companyModelRoute).toEqual({ agentId: 'claude', providerId: 'shared', providerRevision: 2, model: 'approved', protocol: 'anthropic-messages' });
});

test('legacy callers cannot inject a queued provider reference', () => {
  const result = managedCompanyRunBody({ agentId: 'codex', agentModels: { codex: { model: 'approved' } } }, { companyModelRoute: { providerId: 'attacker' } });
  expect(result).not.toHaveProperty('companyModelRoute');
});

test.each(['gpt-6.1-sol', 'vendor/model/version', 'deepseek-official/upstream-model'])(
  'unified DeepSeek model %s reaches the native controller as the original upstream ID', (model) => {
    const route: CompanyModelRoute = {
      agentId: 'deepseek-harness', providerId: 'shared', providerRevision: 2,
      model, protocol: 'chat-completions',
    };
    const originalRoute = { ...route };
    const body = managedCompanyRunBody({}, { message: 'hello' }, route);
    const child = { stdin: new PassThrough(), stdout: new PassThrough() };
    const commands: unknown[] = [];
    child.stdin.on('data', (chunk) => {
      commands.push(parseDshProfileHostCommand(JSON.parse(String(chunk))));
    });
    const controller = attachDshProfileSession({
      child: child as unknown as ChildProcess, requestId: 'company-run', prompt: 'hello', cwd: '/project',
      model: body.model as string, send: () => {},
    });
    child.stdout.write(`${JSON.stringify({
      v: 1, type: 'ready', runtime: 'open-design', protocol_version: 1, plugin_version: 'fixture-1',
      capabilities: { session_resume: true, session_cancel: true, structured_events: true },
    })}\n`);
    expect(controller.executeWasSent()).toBe(true);
    expect(commands).toEqual([expect.objectContaining({
      type: 'execute', model: { provider: 'deepseek-official', id: model },
    })]);
    expect(body.companyModelRoute).toEqual(originalRoute);
    expect(body.companyModelRoute).not.toBe(route);
    expect(route).toEqual(originalRoute);
    child.stdin.destroy();
    child.stdout.destroy();
  },
);

test('legacy DeepSeek native selectors remain unchanged without a unified route', () => {
  const model = 'deepseek-official/deepseek-v4-flash';
  expect(managedCompanyRunBody({
    agentId: 'deepseek-harness', agentModels: { 'deepseek-harness': { model } },
  }, {})).toMatchObject({ agentId: 'deepseek-harness', model });
});

test.each(['codex', 'claude', 'opencode'] as const)('unified %s routes keep raw model IDs', (agentId) => {
  expect(managedCompanyRunBody({}, {}, {
    agentId, providerId: 'shared', providerRevision: 2, model: 'vendor/model', protocol: 'chat-completions',
  })).toMatchObject({ agentId, model: 'vendor/model' });
});
