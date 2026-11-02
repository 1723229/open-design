import { Router, type Express } from 'express';
import type { AgentInfo, CompanyModelAgent } from '@open-design/contracts';
import type { CompanyRuntime } from './routes.js';
import { COMPANY_MODEL_AGENTS, CompanyModelSettingsError, type CompanyModelSettings } from './model-settings.js';

export function registerCompanyModelRoutes(app: Express, deps: {
  company: Pick<CompanyRuntime, 'enabled' | 'getUser'> & { store: Pick<CompanyRuntime['store'], 'audit'> };
  models: CompanyModelSettings;
  detectAgents(): Promise<AgentInfo[]>;
}): void {
  const router = Router();
  let installed: Promise<CompanyModelAgent[]> | undefined;
  const agents = () => installed ??= deps.detectAgents().then(found => COMPANY_MODEL_AGENTS.map(agent => {
    const detected = found.find(item => item.id === agent.id);
    return { ...agent, installed: detected?.available ?? false, ...(detected?.version ? { version: detected.version } : {}) };
  }));
  router.use((req, res, next) => {
    if (!deps.company.enabled) return res.status(404).json({ error: 'Company models are unavailable.' });
    const user = deps.company.getUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    next();
  });
  router.get('/', async (_req, res) => {
    try { res.json(deps.models.view(await agents())); }
    catch { res.status(500).json({ error: 'Model settings are unavailable.', code: 'models_unavailable' }); }
  });
  for (const operation of ['providers', 'test', 'activate', 'catalog'] as const) {
    router[operation === 'providers' ? 'put' : 'post'](`/${operation}`, async (req, res) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'A request object is required.', code: 'invalid_input' });
      try {
        let resource: string;
        if (operation === 'catalog') {
          const catalog = await deps.models.catalog(req.body);
          deps.company.store.audit(deps.company.getUser(req)!.id, 'models.provider.catalog', req.body.providerId);
          return res.json(catalog);
        }
        const installedAgents = await agents();
        if (operation === 'providers') {
          const saved = deps.models.saveProvider(req.body);
          resource = req.body.id ?? saved.providers.at(-1)!.id;
        } else if (operation === 'test') {
          if (req.body.agentId && !installedAgents.some(a => a.id === req.body.agentId && a.installed)) throw new CompanyModelSettingsError(422, 'agent_unavailable', 'Install the selected agent before testing it.');
          await deps.models.testProvider(req.body);
          resource = req.body.providerId;
        } else {
          deps.models.activate(req.body, installedAgents);
          resource = req.body.providerId;
        }
        deps.company.store.audit(deps.company.getUser(req)!.id, operation === 'providers' ? 'models.provider.save' : `models.provider.${operation}`, resource);
        return res.json(deps.models.view(installedAgents));
      } catch (error) {
        if (error instanceof CompanyModelSettingsError) return res.status(error.status).json({ error: error.message, code: error.code });
        return res.status(500).json({ error: 'Model operation failed.', code: 'models_unavailable' });
      }
    });
  }
  router.delete('/providers/:id', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'A request object is required.', code: 'invalid_input' });
    try {
      deps.models.deleteProvider(req.params.id, req.body);
      deps.company.store.audit(deps.company.getUser(req)!.id, 'models.provider.delete', req.params.id);
      return res.json(deps.models.view(await agents()));
    } catch (error) {
      if (error instanceof CompanyModelSettingsError) return res.status(error.status).json({ error: error.message, code: error.code });
      return res.status(500).json({ error: 'Model operation failed.', code: 'models_unavailable' });
    }
  });
  app.use('/api/company/models', router);
}
