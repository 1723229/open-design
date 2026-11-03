import { Router, type Request } from 'express';
import type { CompanyUser } from '@open-design/contracts';
import type { CompanyStore } from './store.js';

export function createCompanyTeamRoutes(store: CompanyStore, enabled: boolean, getUser: (req: Request) => CompanyUser | null): Router {
  const router = Router();
  router.use('/api/company/teams', (req, res, next) => {
    if (!enabled) return void res.status(404).json({error:'Teams are not enabled'});
    if (!getUser(req)) return void res.status(401).json({error:'Authentication required'});
    next();
  });
  router.get('/api/company/teams', (req, res) => res.json({teams:store.teams.list(getUser(req)!)}));
  router.post('/api/company/teams', (req, res) => {
    try { res.status(201).json({team:store.teams.create(req.body?.name,getUser(req)!)}); }
    catch { res.status(400).json({error:'Invalid team'}); }
  });
  router.get('/api/company/teams/:id', (req, res) => {
    const team = store.teams.get(req.params.id!,getUser(req)!);
    if (!team) return void res.status(403).json({error:'Team access denied or permissions expired'});
    res.json({team,members:store.teams.members(team.id)});
  });
  router.patch('/api/company/teams/:id', (req, res) => {
    try { res.json({team:store.teams.update(req.params.id!,req.body ?? {},getUser(req)!)}); }
    catch { res.status(403).json({error:'Team is managed externally or access denied'}); }
  });
  router.put('/api/company/teams/:id/members', (req, res) => {
    try {
      store.teams.setMember(req.params.id!,req.body?.userId,req.body?.role,getUser(req)!);
      res.json({team:store.teams.get(req.params.id!,getUser(req)!),members:store.teams.members(req.params.id!)});
    } catch { res.status(403).json({error:'Cannot update team member'}); }
  });
  router.delete('/api/company/teams/:id/members/:userId', (req, res) => {
    try {
      store.teams.removeMember(req.params.id!,req.params.userId!,getUser(req)!);
      res.json({team:store.teams.get(req.params.id!,getUser(req)!),members:store.teams.members(req.params.id!)});
    } catch { res.status(403).json({error:'Cannot remove team member'}); }
  });
  return router;
}
