import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import type { CompanyIntegrationCodeRequest, CompanyTeamSyncRequest } from '@open-design/contracts';
import { constantEqual, type CompanyAuth } from './auth.js';
import type { CompanyConfig } from './config.js';
import type { CompanyStore } from './store.js';

const BROWSER_COOKIE = 'nexus_design_entry';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
interface Flow {
  state: string; client_id: string; namespace: string; external_id: string; browser_hash: string;
  expires_at: number; code_hash: string | null; code_expires_at: number | null; user_id: string | null; team_id: string | null;
}
export function companyIntegrationRequest(req: Request): boolean {
  return (req.method === 'GET' && /^\/api\/company\/integrations\/[a-z][a-z0-9-]{0,63}\/(?:start|callback|teams)$/u.test(req.path))
    || (req.method === 'POST' && /^\/api\/company\/integrations\/[a-z][a-z0-9-]{0,63}\/(?:teams|codes)$/u.test(req.path));
}

export function createCompanyIntegrationRoutes(deps: {
  config: CompanyConfig; store: CompanyStore; auth: CompanyAuth; now: () => number;
  issueSession(req: Request, res: import('express').Response, user: import('@open-design/contracts').CompanyUser): void;
}): Router {
  const {config, store, auth, now} = deps;
  const router = Router();
  if (!config.enabled || !config.teams?.enabled || !config.integrations?.length) return router;
  store.database.exec(`
    CREATE TABLE IF NOT EXISTS company_integration_flows (
      state TEXT PRIMARY KEY, client_id TEXT NOT NULL, namespace TEXT NOT NULL, external_id TEXT NOT NULL,
      browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, code_hash TEXT, code_expires_at INTEGER,
      user_id TEXT, team_id TEXT
    );
    CREATE TABLE IF NOT EXISTS company_integration_nonces (client_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(client_id,nonce));
  `);
  const fail = (res: import('express').Response, status: number, message: string) => res.status(status).json({error: message});
  const browser = (req: Request) => req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${BROWSER_COOKIE}=`))?.slice(BROWSER_COOKIE.length + 1) ?? '';
  router.all('/api/company/integrations/:clientId/{*operation}', async (req, res, next) => {
    if (!companyIntegrationRequest(req)) return next();
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
    const client = config.integrations!.find(item => item.id === req.params.clientId);
    if (!client) return void fail(res, 404, 'Integration is not enabled');
    const operation = req.path.split('/').pop();
    store.database.prepare('DELETE FROM company_integration_flows WHERE expires_at<=?').run(now());
    store.database.prepare('DELETE FROM company_integration_nonces WHERE expires_at<=?').run(now());
    try {
      if (operation === 'start') {
        const namespace = req.query.namespace, externalId = req.query.externalId;
        if (typeof namespace !== 'string' || !namespace || namespace.length > 200 || typeof externalId !== 'string' || !externalId || externalId.length > 200
          || Object.keys(req.query).some(key => !['namespace','externalId'].includes(key))) return void fail(res,400,'Invalid entry');
        if ((store.database.prepare('SELECT count(*) AS count FROM company_integration_flows').get() as {count:number}).count >= 10_000) return void fail(res,429,'Too many pending entries');
        let binding = browser(req);
        if (!/^[A-Za-z0-9_-]{43}$/u.test(binding)) binding = token();
        res.cookie(BROWSER_COOKIE, binding, {httpOnly:true,sameSite:'lax',secure:config.publicOrigin.startsWith('https:'),path:'/api/company/integrations',maxAge:600_000});
        const state = token();
        store.database.prepare('INSERT INTO company_integration_flows (state,client_id,namespace,external_id,browser_hash,expires_at) VALUES (?,?,?,?,?,?)')
          .run(state,client.id,namespace,externalId,hash(binding),now()+120_000);
        const authorize = new URL(client.authorizeUrl);
        authorize.search = new URLSearchParams({state,instance_id:namespace,team_id:externalId}).toString();
        return void res.redirect(302,authorize.href);
      }
      if (operation === 'callback') {
        const state = req.query.state, code = req.query.code;
        if (typeof state !== 'string' || typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(state) || !/^[A-Za-z0-9_-]{43}$/u.test(code)) return void fail(res,403,'Entry expired; return to the source project');
        const flow = store.database.prepare('SELECT * FROM company_integration_flows WHERE state=? AND client_id=?').get(state,client.id) as Flow | undefined;
        if (!flow || !flow.code_hash || !flow.user_id || !flow.team_id || !flow.code_expires_at || flow.code_expires_at <= now()
          || !constantEqual(flow.browser_hash,hash(browser(req))) || !constantEqual(flow.code_hash,hash(code))) return void fail(res,403,'Entry expired; return to the source project');
        const consumed = store.database.prepare('DELETE FROM company_integration_flows WHERE state=? AND code_hash=?').run(state,hash(code));
        if (!consumed.changes) return void fail(res,403,'Entry already consumed');
        const identity = store.getLdapIdentity(flow.user_id);
        const user = identity ? await auth.loginFederated(identity.entryUUID) : null;
        if (!user || !store.teams.canAccess(user,flow.team_id)) return void fail(res,403,'Directory identity or project membership is unavailable');
        deps.issueSession(req,res,user);
        return void res.redirect(302,`/teams/${encodeURIComponent(flow.team_id)}`);
      }
      const timestamp = req.get('x-nexus-timestamp') ?? '', nonce = req.get('x-nexus-nonce') ?? '', signature = req.get('x-nexus-signature') ?? '';
      if (!/^\d{13}$/u.test(timestamp) || Math.abs(now()-Number(timestamp)) > 60_000 || !/^[A-Za-z0-9_-]{16,128}$/u.test(nonce) || !/^[a-f0-9]{64}$/u.test(signature)) return void fail(res,403,'Invalid integration signature');
      // The wire body is JSON.stringify(parsed JSON), allowing ordinary Express JSON middleware.
      const body = req.method === 'GET' ? '' : JSON.stringify(req.body ?? null);
      const expected = createHmac('sha256',client.secret).update(`${req.method}\n${req.originalUrl}\n${timestamp}\n${nonce}\n${hash(body)}`).digest('hex');
      if (!constantEqual(signature,expected)) return void fail(res,403,'Invalid integration signature');
      try { store.database.prepare('INSERT INTO company_integration_nonces VALUES (?,?,?)').run(client.id,nonce,now()+300_000); }
      catch { return void fail(res,403,'Integration request already consumed'); }
      if (operation === 'teams' && req.method === 'GET') return void res.json({mappings:store.teams.mappings(client.id)});
      if (operation === 'teams') {
        const input = req.body as CompanyTeamSyncRequest;
        if (config.auth.ldap?.autoCreate === false && input.members?.some(member => !store.listUsers().some(user => store.getLdapIdentity(user.id)?.entryUUID === member.entryUUID))) return void fail(res,400,'Directory user provisioning is disabled');
        const team = store.teams.sync(client.id,input.namespace,input.externalId,input,input.expectedRevision);
        return void res.json({team});
      }
      const input = req.body as CompanyIntegrationCodeRequest;
      const flow = store.database.prepare('SELECT * FROM company_integration_flows WHERE state=? AND client_id=?').get(input.state,client.id) as Flow | undefined;
      const mapping = store.teams.mappings(client.id).find(item => item.teamId === input.teamId);
      const user = store.listUsers().find(item => store.getLdapIdentity(item.id)?.entryUUID === input.entryUUID);
      if (!flow || flow.code_hash || !mapping || mapping.namespace !== flow.namespace || mapping.externalId !== flow.external_id
        || !user || !store.teams.canAccess(user,input.teamId)) return void fail(res,403,'Entry identity or membership unavailable');
      const code = token();
      store.database.prepare('UPDATE company_integration_flows SET code_hash=?,code_expires_at=?,user_id=?,team_id=? WHERE state=?')
        .run(hash(code),now()+60_000,user.id,input.teamId,input.state);
      res.json({code});
    } catch (error) {
      const conflict = error instanceof Error && error.message === 'Team revision conflict';
      fail(res,conflict ? 409 : 400,conflict ? 'Team revision conflict' : 'Invalid integration request');
    }
  });
  return router;
}
