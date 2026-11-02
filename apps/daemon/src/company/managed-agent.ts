import type { AppConfigPrefs } from '../app-config.js';
import type { CompanyModelRoute } from '@open-design/contracts';

const AGENTS = new Set(['codex', 'claude', 'opencode', 'deepseek-harness']);
export function publicCompanyConfig(config: AppConfigPrefs): AppConfigPrefs {
  return {onboardingCompleted:true,...(config.agentId !== undefined ? {agentId:config.agentId} : {}),...(config.agentModels ? {agentModels:config.agentModels} : {})};
}
export function managedCompanyRunBody(config: AppConfigPrefs, input: Record<string, unknown>, route?: CompanyModelRoute): Record<string, unknown> {
  const agentId = route?.agentId ?? config.agentId;
  const prefs = agentId ? config.agentModels?.[agentId] : undefined;
  const model = route?.model ?? prefs?.model;
  if (!agentId || !AGENTS.has(agentId) || !model) throw new Error('管理员尚未配置默认执行器和模型');
  // The native company profile needs a selector; the route keeps the raw upstream ID.
  const runModel = route && agentId === 'deepseek-harness' ? `deepseek-official/${model}` : model;
  const body: Record<string,unknown> = {...input,agentId,model:runModel,reasoning:prefs?.reasoning,serviceTier:prefs?.serviceTier};
  for (const field of ['byokProvider','env','agentCliEnv','cwd','workingDir','linkedDirs','companyUserId','companyJobId','companyModelRoute']) delete body[field];
  if (route) body.companyModelRoute = { ...route };
  return body;
}

/** Project unified routing into the existing bootstrap DTO without exposing keys. */
export function managedCompanyConfig(config: AppConfigPrefs, route: CompanyModelRoute | null): AppConfigPrefs {
  const { agentCliEnv: _credentials, agentCliEnvIntent: _intent, ...safe } = config;
  return {
    ...safe, agentId: route?.agentId ?? null,
    agentModels: route ? { ...config.agentModels, [route.agentId]: { ...config.agentModels?.[route.agentId], model: route.model } } : {},
  };
}
