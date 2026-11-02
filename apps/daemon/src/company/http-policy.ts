import { createHash } from 'node:crypto';
import type { Express } from 'express';
import type { AgentInfo, CompanyModelRoute } from '@open-design/contracts';
import type { AppConfigPrefs } from '../app-config.js';
import type { CompanyRuntime } from './routes.js';
import { getCompanyTask } from './routes.js';
import { companyMemberProjectPatchAllowed, companyRequestIsWrite } from './policy.js';
import { managedCompanyConfig, managedCompanyRunBody, publicCompanyConfig } from './managed-agent.js';
import { resolveCompanyInputPaths } from './input-paths.js';

/** The original settings UI may edit generation preferences, never managed routing. */
function agentPreferences(input: unknown, saved: AppConfigPrefs['agentModels']): AppConfigPrefs['agentModels'] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const result = structuredClone(saved ?? {});
  let changed = false;
  for (const id of ['codex','claude','opencode','deepseek-harness']) {
    const entry = (input as Record<string, unknown>)[id];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid Agent preferences');
    for (const field of ['reasoning','serviceTier'] as const) {
      const value = (entry as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (value !== null && (typeof value !== 'string' || value.length > 128)) throw new Error('Invalid Agent preferences');
      const prefs = result[id] ??= {};
      if (value === null || !(value as string).trim()) delete prefs[field];
      else prefs[field] = (value as string).trim();
      changed = true;
    }
  }
  return changed ? result : null;
}

/** Admission owns its route until the async handler settles, even after transport close. */
export function createCompanyModelAdmissionHolds(): {
  routes: Map<import('express').Request, CompanyModelRoute>;
  holdModelRoute(req: import('express').Request, res: import('express').Response, route: CompanyModelRoute): void;
  settleModelRoute(req: import('express').Request): void;
} {
  const routes = new Map<import('express').Request, CompanyModelRoute>();
  return {
    routes,
    holdModelRoute(req, _res, route) { routes.set(req, route); },
    settleModelRoute(req) { routes.delete(req); },
  };
}

export function installCompanyHttpPolicy(app: Express, deps: {
  company: Pick<CompanyRuntime, 'enabled' | 'getUser'>;
  readConfig(): Promise<AppConfigPrefs>;
  detectAgents(env?: Record<string, Record<string, string>>): Promise<AgentInfo[]>;
  models?: { pinActive(): CompanyModelRoute };
  holdModelRoute?(req: import('express').Request, res: import('express').Response, route: CompanyModelRoute): void;
  resolveProjectRoot?(projectId: string): string;
  projectIsExecuting?(projectId: string): boolean;
}): void {
  app.use(async (req, res, next) => {
    if (!deps.company.enabled) return next();
    // Generated documents must never execute with the platform's login origin.
    // The upstream powered origin is loopback-only; remote company deployments use the standard sandbox.
    if (/^\/api\/projects\/[^/]+\/powered(?:\/|$)/u.test(req.path)) return res.status(403).json({error:'当前部署使用标准沙箱预览'});
    if (/^\/api\/projects\/[^/]+\/(?:files|raw|preview)(?:\/|$)|^\/artifacts\//u.test(req.path)) {
      res.setHeader('Content-Security-Policy','sandbox allow-scripts allow-forms allow-downloads');
      res.setHeader('X-Content-Type-Options','nosniff');
    }
    const principal = deps.company.getUser(req);
    if (!principal) return next();
    const activeRoute = () => {
      try { return deps.models?.pinActive() ?? null; } catch { return null; }
    };
    const projectMutation = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/u.exec(req.path);
    if (projectMutation && companyRequestIsWrite(req) && !getCompanyTask(req)) {
      const operation = projectMutation[2] ?? '';
      const readOrInput = /^(?:tabs|export(?:\/.*)?|archive(?:\/.*)?|preview(?:\/.*)?|preview-url|submissions|comments\/read)$/u.test(operation);
      const conversationSync = (req.method === 'PUT' && /^conversations\/[^/]+\/messages\/[^/]+$/u.test(operation))
        || (req.method === 'PATCH' && /^conversations\/[^/]+$/u.test(operation));
      const presentationSync = req.method === 'PATCH' && !operation && companyMemberProjectPatchAllowed(req.body);
      if (!readOrInput && !conversationSync && !presentationSync && deps.projectIsExecuting?.(decodeURIComponent(projectMutation[1]!))) return res.status(409).json({error:'项目正在生成，请等待完成后再修改文件',code:'PROJECT_BUSY'});
    }
    if (req.method === 'GET' && req.path === '/api/workspace/directory') return res.json({items:[],activeWorkspaceId:null});
    if (req.method === 'GET' && ['/api/app-config','/api/config'].includes(req.path) && (deps.models || principal.role !== 'admin')) {
      const saved = await deps.readConfig();
      const config = deps.models ? managedCompanyConfig(saved, activeRoute()) : saved;
      return res.json({config:principal.role === 'admin' ? config : publicCompanyConfig(config)});
    }
    if (deps.models && ['PUT','PATCH','POST'].includes(req.method) && ['/api/app-config','/api/config'].includes(req.path)) {
      const route = activeRoute();
      const body = req.body ?? {};
      const executionFields = ['agentId','agentModels','agentCliEnv','agentCliEnvIntent'];
      const preferences = Object.keys(body).filter(key => !executionFields.includes(key));
      let models: AppConfigPrefs['agentModels'] | null = null;
      try { if (principal.role === 'admin' && body.agentModels !== undefined) models = agentPreferences(body.agentModels, (await deps.readConfig()).agentModels); }
      catch { return res.status(400).json({error:'Agent 偏好设置无效',code:'INVALID_AGENT_PREFERENCES'}); }
      if (!preferences.length && !models && executionFields.some(key => body[key] !== undefined)) {
        return res.status(409).json({error:'请在 API 供应商与执行 Agent 中测试并启用配置',code:'MANAGED_MODELS_REQUIRED'});
      }
      for (const field of executionFields) delete body[field];
      if (models) body.agentModels = models;
      const json = res.json.bind(res);
      res.json = value => json(value?.config ? { ...value, config: managedCompanyConfig(value.config, route) } : value);
    }
    if (req.method === 'GET' && req.path === '/api/agents' && principal.role !== 'admin') {
      const saved = await deps.readConfig();
      const config = deps.models ? { ...saved, ...managedCompanyConfig(saved, activeRoute()) } : saved;
      const selected = (await deps.detectAgents(config.agentCliEnv)).find(a => a.id === config.agentId);
      const agent = {
        id:config.agentId ?? '',name:'NexusDesign',bin:selected?.bin ?? '',
        available:selected?.available ?? false,authStatus:deps.models && selected?.available ? 'ok' : selected?.authStatus ?? 'missing',
        ...(selected?.models ? {models:selected.models} : {}),
      };
      if (req.query.stream === '1') {
        res.setHeader('content-type','text/event-stream');
        return res.end(`event: agent\ndata: ${JSON.stringify(agent)}\n\nevent: done\ndata: {}\n\n`);
      }
      return res.json({agents:[agent]});
    }
    if (req.method === 'POST' && ['/api/runs','/api/chat'].includes(req.path)) {
      try {
        const config = await deps.readConfig();
        const route = deps.models?.pinActive();
        req.body = managedCompanyRunBody(config, req.body ?? {}, route);
        if (req.body.imagePaths || req.body.attachments || req.body.commentAttachments) {
          if (!deps.resolveProjectRoot || typeof req.body.projectId !== 'string') throw new Error('附件必须属于当前项目');
          Object.assign(req.body,resolveCompanyInputPaths({projectRoot:deps.resolveProjectRoot(req.body.projectId),imagePaths:req.body.imagePaths,attachments:req.body.attachments,commentAttachments:req.body.commentAttachments}));
        }
        if (typeof req.body.clientRequestId === 'string' && req.body.clientRequestId) {
          req.body.clientRequestId = createHash('sha256').update(`${principal.id}\0${req.body.clientRequestId}`).digest('hex');
        }
        if (route) deps.holdModelRoute?.(req, res, route);
      } catch (error) {
        return res.status(503).json({error:error instanceof Error ? error.message : '模型配置不可用'});
      }
    }
    next();
  });
}
