import type Database from 'better-sqlite3';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type {
  CompanyProjectRole, CompanySessionResponse, CompanySessionUser, CompanyUser, CompanyUserUpdateRequest,
  ProjectBrowserWorkspaceTab,
} from '@open-design/contracts';
import { CompanyAuth, companyProviderFingerprint, constantEqual, createLdapDirectory, type CompanyLdap } from './auth.js';
import { loadCompanyConfig, type CompanyConfig } from './config.js';
import { CompanyStore, type CompanyRevocation, type CompanyStoredSession } from './store.js';
import { companyMemberPolicy, companyRequestIsWrite, companyTaskPolicy } from './policy.js';
import { createCompanyTeamRoutes } from './team-routes.js';
import { companyIntegrationRequest, createCompanyIntegrationRoutes } from './integrations.js';

const COOKIE = 'od_company_session';
const requestSessions = new WeakMap<Request, CompanyStoredSession>();
const requestTokens = new WeakMap<Request, string>();
const requestTasks = new WeakMap<Request, CompanyTaskPrincipal>();

export interface CompanyTaskPrincipal { userId: string; projectId: string; legacyToolToken?: string }
export function getCompanyTask(req: Request): CompanyTaskPrincipal | null { return requestTasks.get(req) ?? null; }

export function getCompanyUser(req: Request): CompanyUser | null { return requestSessions.get(req)?.user ?? null; }

export interface CompanyRuntime {
  enabled: boolean;
  config: CompanyConfig;
  store: CompanyStore;
  auth: CompanyAuth;
  middleware: RequestHandler;
  router: Router;
  getUser(req: Request): CompanyUser | null;
  previewOwnerKey(req: Request): string;
  canAccess(user: CompanySessionUser | null, projectId: string, write?: boolean): boolean;
  filterProjects<T extends { id: string }>(req: Request, projects: T[]): T[];
  claimProject(req: Request, projectId: string, sourceProjectId?: string): void;
  registerProjectOwner(projectId: string, user: CompanyUser): void;
  onRevoke(listener: (event: CompanyRevocation) => void): () => void;
}

export interface InitializeCompanyOptions {
  dataRoot: string;
  database: Database.Database;
  config?: CompanyConfig;
  ldap?: CompanyLdap;
  now?: () => number;
  resolveRunProjectId?: (runId: string) => string | null;
  resolveProjectMetadata?: (projectId: string) => unknown;
  projectIsBusy?: (projectId: string) => boolean;
  taskStatus?: (user:CompanyUser) => import('@open-design/contracts').CompanyTaskStatusResponse;
  authenticateTask?: (req: Request) => CompanyTaskPrincipal | null;
  resolvePreviewOwner?: (req: Request) => {projectId: string; ownerKey: string} | null;
}

function error(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message, code: status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST' });
}

function cookieToken(req: Request): string {
  const value = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : '';
}

function sessionCookie(res: Response, config: CompanyConfig, token: string, clear = false): void {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.publicOrigin.startsWith('https://'), path: '/', maxAge: clear ? 0 : 8 * 60 * 60 * 1000 });
}

export async function initializeCompany(options: InitializeCompanyOptions): Promise<CompanyRuntime> {
  const config = options.config ?? loadCompanyConfig(options.dataRoot);
  const store = new CompanyStore(options.database, options.now);
  if (!config.enabled && store.wasEnabled()) throw new Error('Cannot disable company authentication on a company database');
  const ldap = options.ldap ?? (config.auth.ldap ? createLdapDirectory(config.auth.ldap) : undefined);
  if (config.enabled && config.auth.mode === 'ldap' && !ldap) throw new Error('Company LDAP configuration is required');
  const auth = new CompanyAuth(store, config, options.dataRoot, ldap, options.now);
  if (config.enabled) {
    store.applyProviderFingerprint(companyProviderFingerprint(config));
    auth.bootstrap();
    store.markEnabled();
  }
  const router = Router();
  const requestPolicy = (req: Request) => companyMemberPolicy(req, options.resolveRunProjectId, (snapshotId) => {
    const row = store.database.prepare('SELECT project_id AS projectId FROM applied_plugin_snapshots WHERE id=?').get(snapshotId) as {projectId: string | null} | undefined;
    return row?.projectId ?? null;
  }, options.resolveProjectMetadata);
  router.use(createCompanyIntegrationRoutes({config,store,auth,now:options.now ?? Date.now,issueSession(req,res,user) {
    const previous = cookieToken(req);
    // Opening another source project must not invalidate existing tabs' CSRF state.
    if (previous && store.getSession(previous)?.user.id === user.id) return;
    if (previous) store.deleteSession(previous);
    sessionCookie(res,config,auth.createSession(user).token);
  }}));
  router.use(createCompanyTeamRoutes(store,config.enabled && config.teams?.enabled === true,getCompanyUser));
  const sessionResponse = (session: CompanyStoredSession | undefined): CompanySessionResponse => ({
    enabled: config.enabled,
    teamsEnabled: config.enabled && config.teams?.enabled === true,
    ...(config.enabled ? { authMode: config.auth.mode } : {}),
    user: session ? { id: session.user.id, username: session.user.username, ...(session.user.displayName ? { displayName: session.user.displayName } : {}), role: session.user.role, mustChangePassword: session.user.mustChangePassword } : null,
    presentation: config.presentation,
    ...(session ? { csrfToken: session.csrfToken } : {}),
  });
  const streams = new Set<{ response: Response; token: string; userId: string; projectId?: string }>();
  store.onRevoke((event) => {
    for (const stream of streams) {
      if (stream.userId !== event.userId || (event.projectId && stream.projectId !== event.projectId)) continue;
      if (!String(stream.response.getHeader('content-type') ?? '').includes('text/event-stream')) continue;
      const current = store.getSession(stream.token);
      if (event.reason !== 'permissions' || !current || (stream.projectId && !store.canAccess(current.user, stream.projectId))) stream.response.end();
    }
  });
  const trackStream = (res: Response, token: string, principal: CompanyUser, projectId?: string) => {
    const stream = { response: res, token, userId: principal.id, ...(projectId ? { projectId } : {}) };
    streams.add(stream);
    let checking = false;
    const timer = setInterval(() => {
      if (checking || res.writableEnded || res.destroyed || !String(res.getHeader('content-type') ?? '').includes('text/event-stream')) return;
      checking = true;
      void auth.session(token).then((current) => {
        if (!current || (projectId && !store.canAccess(current.user, projectId))) res.end();
      }).catch(() => res.end()).finally(() => { checking = false; });
    }, 30_000);
    timer.unref();
    const cleanup = () => { clearInterval(timer); streams.delete(stream); };
    res.once('finish', cleanup);
    res.once('close', cleanup);
  };

  const middleware: RequestHandler = async (req, res, next) => {
    if (!config.enabled) return next();
    const protectedPath = /^\/(?:api(?:\/|$)|artifacts(?:\/|$)|frames(?:\/|$)|powered(?:\/|$))/iu.test(req.path);
    if (!protectedPath) return next();
    // Express matches literal route prefixes without case sensitivity by default.
    if (!/^\/(?:api(?:\/|$)|artifacts(?:\/|$)|frames(?:\/|$)|powered(?:\/|$))/u.test(req.path)) return error(res, 403, 'Invalid request path');
    res.setHeader('Cache-Control', 'no-store');
    if (config.teams?.enabled) store.teams.expire();
    if (companyIntegrationRequest(req) && config.teams?.enabled && config.integrations?.length) return next();
    if (/^\/api\/projects(?:\/[^/]+(?:\/duplicate)?)?$/u.test(req.path)) {
      const json = res.json.bind(res);
      const decorate = (project: {id:string}) => {
        const actor=getCompanyUser(req);
        return {...project,companyTeamId:store.teams.projectTeamId(project.id),...(actor ? {companyAccess:{
          canWrite:store.canAccess(actor,project.id,true),canComment:store.canComment(actor,project.id),
          canManage:store.canManage(actor,project.id),ownerUserId:store.teams.projectOwnerId(project.id),
        }} : {})};
      };
      res.json = body => json(body?.project ? {...body,project:decorate(body.project)} : body?.projects ? {...body,projects:body.projects.map(decorate)} : body);
    }
    const preview = options.resolvePreviewOwner?.(req);
    if (preview) {
      if (!['GET','HEAD'].includes(req.method)) return error(res,403,'Preview scope is read-only');
      if (preview.ownerKey.startsWith('session:')) {
        const token = preview.ownerKey.slice('session:'.length);
        const session = await auth.session(token);
        if (!session || !store.canAccess(session.user,preview.projectId)) return error(res,401,'Preview session expired');
        requestSessions.set(req,session); requestTokens.set(req,token);
        return next();
      }
      if (preview.ownerKey.startsWith('task:')) {
        const scoped = Object.assign(Object.create(req) as Request,{headers:{...req.headers,authorization:`Bearer ${preview.ownerKey.slice('task:'.length)}`}});
        const task = options.authenticateTask?.(scoped);
        const principal = task ? store.getUser(task.userId) : null;
        if (!task || task.projectId !== preview.projectId || !principal || !await auth.userEligible(principal.id) || !store.canAccess(principal,preview.projectId)) return error(res,401,'Preview task expired');
        requestTasks.set(req,task); requestSessions.set(req,{user:principal,csrfToken:'',ldapCheckedAt:0,expiresAt:0});
        return next();
      }
      return error(res,401,'Preview owner unavailable');
    }
    const task = options.authenticateTask?.(req);
    if (task) {
      const principal = store.getUser(task.userId);
      const toolRequest = req.path.startsWith('/api/tools/');
      if (!principal || !await auth.userEligible(principal.id) || !store.canAccess(principal, task.projectId, companyRequestIsWrite(req)) || !companyTaskPolicy(req, task.projectId) || (toolRequest && !task.legacyToolToken)) return error(res, 403, 'Task scope denied');
      requestTasks.set(req, task);
      requestSessions.set(req, { user: principal, csrfToken: '', ldapCheckedAt: 0, expiresAt: 0 });
      if (toolRequest && task.legacyToolToken) req.headers.authorization = `Bearer ${task.legacyToolToken}`;
      return next();
    }
    const token = cookieToken(req);
    const session = token ? await auth.session(token) : null;
    if (session) {
      requestSessions.set(req, session);
      requestTokens.set(req, token);
    }
    if (req.method === 'GET' && req.path === '/api/analytics/config') return void res.json({enabled:false,env:'production',key:null,host:null,installationId:null});
    // Company deployments do not send desktop/cloud client telemetry. Keep its
    // bootstrap transport inert, without opening a write capability before login.
    if (req.method === 'POST' && req.path === '/api/observability/event') {
      if (req.headers.origin !== config.publicOrigin) return error(res,403,'Invalid request origin');
      return void res.status(204).end();
    }
    const publicRead = req.method === 'GET' && ['/api/health', '/api/ready', '/api/version', '/api/company/session'].includes(req.path);
    const login = req.method === 'POST' && req.path === '/api/company/auth/login';
    if (publicRead) return next();
    if (companyRequestIsWrite(req)) {
      const origin = req.headers.origin;
      if (origin && origin !== config.publicOrigin) return error(res, 403, 'Invalid request origin');
      // Login has no session token yet; require its explicit deployment origin.
      if (login) {
        if (origin !== config.publicOrigin) return error(res, 403, 'Invalid request origin');
        return next();
      }
    }
    if (!session) return error(res, 401, 'Authentication required');
    if (companyRequestIsWrite(req)) {
      const csrfToken = req.get('x-csrf-token') ?? '';
      if (!constantEqual(csrfToken, session.csrfToken)) return error(res, 403, 'Invalid CSRF token');
    }
    if (session.user.mustChangePassword && !['/api/company/auth/password', '/api/company/auth/logout'].includes(req.path)) return error(res, 403, 'Password change required');
    if (req.method === 'POST' && req.path === '/api/projects' && req.body?.companyTeamId !== undefined) {
      if (!config.teams?.enabled || typeof req.body.companyTeamId !== 'string' || !store.teams.canAccess(session.user,req.body.companyTeamId,true)) return error(res,403,'Team write permission required');
    }
    if (session.user.role === 'admin') {
      const policy = requestPolicy(req);
      const projectId = policy.projectId ?? /^\/api\/projects\/([^/]+)/u.exec(req.path)?.[1]
        ?? options.resolveRunProjectId?.(/^\/api\/runs\/([^/]+)/u.exec(req.path)?.[1] ?? '');
      if (projectId) store.audit(session.user.id, companyRequestIsWrite(req) ? 'admin.project.write' : 'admin.project.read', decodeURIComponent(projectId));
      if (projectId && store.teams.projectTeamId(decodeURIComponent(projectId)) && !(policy.comment ? store.canComment(session.user,decodeURIComponent(projectId)) : store.canAccess(session.user,decodeURIComponent(projectId),policy.allowed ? policy.write : companyRequestIsWrite(req)))) return error(res,403,'Team is read-only');
      trackStream(res, token, session.user, projectId ? decodeURIComponent(projectId) : undefined);
      return next();
    }
    const policy = requestPolicy(req);
    if (!policy.allowed || (policy.projectId && (!(policy.comment ? store.canComment(session.user,policy.projectId) : store.canAccess(session.user, policy.projectId, policy.write)) || (policy.ownerOnly && !store.canManage(session.user, policy.projectId))))) return error(res, 403, 'Access denied');
    trackStream(res, token, session.user, policy.projectId);
    next();
  };

  router.get('/api/company/session', (req, res) => res.json(sessionResponse(requestSessions.get(req))));
  router.get('/api/company/tasks',(req,res)=>{
    const user=getCompanyUser(req);
    if(!config.enabled || !user) return error(res,401,'Authentication required');
    if(!options.taskStatus) return void res.status(503).json({error:'Task status is unavailable'});
    res.json(options.taskStatus(user));
  });
  router.post('/api/company/auth/login', async (req, res) => {
    if (!config.enabled) return error(res, 400, 'Company authentication is disabled');
    const { username, password } = req.body ?? {};
    const principal = typeof username === 'string' && typeof password === 'string' ? await auth.login(username, password, req.socket.remoteAddress ?? '') : null;
    if (!principal) return error(res, 401, 'Invalid username or password');
    const previous = cookieToken(req);
    if (previous) store.deleteSession(previous);
    const session = auth.createSession(principal);
    sessionCookie(res, config, session.token);
    res.json(sessionResponse(store.getSession(session.token) ?? undefined));
  });
  router.post('/api/company/auth/logout', (req, res) => {
    const token = requestTokens.get(req);
    const principal = getCompanyUser(req);
    if (token) store.deleteSession(token);
    if (principal) store.audit(principal.id, 'logout', principal.id);
    sessionCookie(res, config, '', true);
    res.json({ ok: true });
  });
  router.post('/api/company/auth/password', (req, res) => {
    const principal = getCompanyUser(req);
    const { currentPassword, newPassword } = req.body ?? {};
    if (!principal || typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !auth.changePassword(principal, currentPassword, newPassword)) return error(res, 400, 'Password change failed; use a new password of at least 12 characters');
    const session = auth.createSession(store.getUser(principal.id)!);
    sessionCookie(res, config, session.token);
    res.json(sessionResponse(store.getSession(session.token) ?? undefined));
  });

  const requireUser = (req: Request, res: Response): CompanyUser | null => {
    const principal = getCompanyUser(req);
    if (!config.enabled || !principal) { error(res, 401, 'Authentication required'); return null; }
    return principal;
  };
  const requireAdmin = (req: Request, res: Response): CompanyUser | null => {
    const principal = requireUser(req, res);
    if (!principal) return null;
    if (principal.role !== 'admin') { error(res, 403, 'Administrator required'); return null; }
    return principal;
  };
  router.get('/api/company/users', (req, res) => {
    if (!requireUser(req, res)) return;
    res.json({ users: store.listUsers() });
  });
  router.post('/api/company/users', (req, res) => {
    const actor = requireAdmin(req, res);
    if (!actor) return;
    if (config.auth.mode !== 'local') return error(res, 403, 'Local member provisioning requires local authentication mode');
    const { username, password, role = 'member' } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !['admin', 'member'].includes(role)) return error(res, 400, 'Invalid local user');
    try { res.status(201).json({ user: store.createLocalUser(username, password, role, actor.id) }); }
    catch { error(res, 400, 'Cannot create local user'); }
  });
  router.patch('/api/company/users/:id', (req, res) => {
    const actor = requireAdmin(req, res);
    if (!actor) return;
    const { role, disabled } = req.body ?? {};
    if ((role !== undefined && !['admin', 'member'].includes(role)) || (disabled !== undefined && typeof disabled !== 'boolean') || (role === undefined && disabled === undefined)) return error(res, 400, 'Invalid user update');
    const update: CompanyUserUpdateRequest = { ...(role !== undefined ? { role } : {}), ...(disabled !== undefined ? { disabled } : {}) };
    try { res.json({ user: store.updateUser(req.params.id!, update, actor.id) }); } catch { error(res, 400, 'Cannot update user'); }
  });
  router.post('/api/company/users/:id/revoke', (req, res) => {
    const actor = requireAdmin(req, res);
    if (!actor) return;
    if (!store.getUser(req.params.id!)) return error(res, 400, 'Unknown user');
    store.revokeSessions(req.params.id!, actor.id);
    res.json({ ok: true });
  });
  router.get('/api/company/audit', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ events: store.listAudit() });
  });

  router.get('/api/company/projects/:id/members', (req, res) => {
    const actor = requireUser(req, res);
    if (!actor) return;
    const projectId = req.params.id!;
    if (!store.canAccess(actor, projectId)) return error(res, 403, 'Access denied');
    const teamId = store.teams.projectTeamId(projectId);
    res.json({ members: store.members(projectId), canManage: !teamId && store.canManage(actor, projectId), canWrite:store.canAccess(actor,projectId,true), canComment:store.canComment(actor,projectId),ownerUserId:store.teams.projectOwnerId(projectId), ...(teamId ? {team:store.teams.get(teamId,actor)} : {}) });
  });
  // Internal sharing uses project membership. Preserve the original deletion
  // preflight and report any retained public links from the local store.
  router.get('/api/projects/:id/share-state', (req,res,next) => {
    if(!config.enabled) return next();
    const actor=requireUser(req,res),projectId=req.params.id!;
    if(!actor) return;
    if(!store.canAccess(actor,projectId)) return error(res,403,'Access denied');
    const publications=store.database.prepare('SELECT file_path AS sourceFilePath,slug FROM public_file_publications WHERE project_id=?')
      .all(projectId) as Array<{sourceFilePath:string;slug:string}>;
    res.setHeader('Cache-Control','no-store');
    res.json({projectId,bindingExists:publications.length>0,hasEverShared:publications.length>0,
      publications:publications.map(row=>({...row,status:'active'}))});
  });
  router.post('/api/company/projects/:id/move', (req,res) => {
    const actor=requireUser(req,res);
    if (!actor) return;
    if (!config.teams?.enabled) return error(res,404,'Teams are not enabled');
    const projectId=req.params.id!,teamId=req.body?.companyTeamId;
    if (teamId !== null && (typeof teamId !== 'string' || !teamId)) return error(res,400,'companyTeamId must be a team ID or null');
    if (!store.canManage(actor,projectId)) return error(res,403,'Project owner or team administrator required');
    if (options.projectIsBusy?.(projectId)) return void res.status(409).json({error:'请先停止此项目的运行或排队任务',code:'PROJECT_BUSY'});
    try { store.teams.moveProject(projectId,teamId,actor);res.json({projectId,companyTeamId:store.teams.projectTeamId(projectId)}); }
    catch { error(res,403,'Cannot change project ownership'); }
  });
  const updateMember: RequestHandler = (req, res) => {
    const actor = requireUser(req, res);
    if (!actor) return;
    const projectId = String(req.params.id);
    const userId = req.params.userId ?? req.body?.userId;
    const role = req.body?.role as CompanyProjectRole;
    if (store.teams.projectTeamId(projectId)) return error(res,403,'Manage membership in the team');
    if (!store.canManage(actor, projectId)) return error(res, 403, 'Project owner required');
    if (typeof userId !== 'string' || !['owner', 'editor', 'viewer'].includes(role) || !store.getUser(userId)) return error(res, 400, 'Invalid project member');
    if (role === 'owner' || store.projectRole(projectId, userId) === 'owner') return error(res, 400, 'Project owner cannot be changed');
    store.setMember(projectId, userId, role, actor.id);
    res.json({ members: store.members(projectId), canManage: true });
  };
  router.put('/api/company/projects/:id/members', updateMember);
  router.put('/api/company/projects/:id/members/:userId', updateMember);
  router.delete('/api/company/projects/:id/members/:userId', (req, res) => {
    const actor = requireUser(req, res);
    if (!actor) return;
    const projectId = req.params.id!;
    const userId = req.params.userId!;
    if (store.teams.projectTeamId(projectId)) return error(res,403,'Manage membership in the team');
    if (!store.canManage(actor, projectId)) return error(res, 403, 'Project owner required');
    if (store.projectRole(projectId, userId) === 'owner') return error(res, 400, 'Project owner cannot be removed');
    store.removeMember(projectId, userId, actor.id);
    res.json({ members: store.members(projectId), canManage: true });
  });

  router.get('/api/projects/:id/tabs', (req, res, next) => {
    if (!config.enabled) return next();
    const principal = getCompanyUser(req);
    if (!principal || !store.canAccess(principal, req.params.id!)) return error(res, 403, 'Access denied');
    res.json(store.getTabs(req.params.id!, principal.id));
  });
  router.put('/api/projects/:id/tabs', (req, res, next) => {
    if (!config.enabled) return next();
    const principal = getCompanyUser(req);
    if (!principal || !store.canAccess(principal, req.params.id!)) return error(res, 403, 'Access denied');
    const { tabs = [], active = null, browserTabs = [] } = req.body ?? {};
    if (!Array.isArray(tabs) || !tabs.every((tab) => typeof tab === 'string') || !Array.isArray(browserTabs)) return error(res, 400, 'Invalid tabs state');
    const browsers: ProjectBrowserWorkspaceTab[] = [];
    for (const value of browserTabs) {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.trim() || typeof value.label !== 'string' || !value.label.trim()) continue;
      const tab: ProjectBrowserWorkspaceTab = { id: value.id, label: value.label };
      if (value.insertAfter === null || typeof value.insertAfter === 'string') tab.insertAfter = value.insertAfter;
      for (const key of ['title', 'url', 'iconUrl'] as const) if (typeof value[key] === 'string' && value[key].trim()) tab[key] = value[key];
      browsers.push(tab);
    }
    res.json(store.setTabs(req.params.id!, principal.id, { tabs, active: typeof active === 'string' ? active : null, ...(browsers.length ? { browserTabs: browsers } : {}) }));
  });

  return {
    enabled: config.enabled, config, store, auth, middleware, router, getUser: getCompanyUser,
    previewOwnerKey: (req) => {
      if (!config.enabled || !getCompanyUser(req)) return '';
      const token = requestTokens.get(req);
      if (token) return `session:${token}`;
      return requestTasks.has(req) ? `task:${String(req.headers.authorization ?? '').replace(/^Bearer\s+/i,'')}` : '';
    },
    canAccess: (principal, projectId, write = false) => !config.enabled || store.canAccess(principal, projectId, write),
    filterProjects: (req, projects) => !config.enabled ? projects : projects.filter((project) => store.canAccess(getCompanyUser(req), project.id)),
    claimProject: (req, projectId, sourceProjectId) => {
      if (!config.enabled) return;
      const principal = getCompanyUser(req);
      if (!principal) throw new Error('Company project owner is required');
      const teamId = sourceProjectId ? store.teams.projectTeamId(sourceProjectId) : req.body?.companyTeamId;
      if (teamId) {
        if (!config.teams?.enabled || typeof teamId !== 'string') throw new Error('Teams are not enabled');
        store.teams.attach(projectId,teamId,principal);
      } else store.registerProjectOwner(projectId, principal);
    },
    registerProjectOwner: (projectId, principal) => { if (config.enabled) store.registerProjectOwner(projectId, principal); },
    onRevoke: (listener) => store.onRevoke(listener),
  };
}
