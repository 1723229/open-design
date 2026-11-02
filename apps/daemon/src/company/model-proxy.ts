import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { CompanyModelProtocol } from '@open-design/contracts';

export interface CompanyModelLease {
  id: string;
  projectId?: string;
  token: string;
  agentId: string;
  model: string;
  maxTokens?: number;
  baseUrl: string;
  apiKey: string;
  protocol: 'openai' | 'anthropic';
  wireProtocol?: CompanyModelProtocol;
  expiresAt: number;
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 32 * 1024 * 1024) throw new Error('request too large');
    chunks.push(Buffer.from(chunk));
  }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid body');
  return result as Record<string, unknown>;
}
/** Trusted proxy in the API process: provider keys never enter the agent container. */
export function createCompanyModelProxy(options: {controlSecret: string; daemonOrigin?: string; now?: () => number}): Server {
  if (!options.controlSecret) throw new Error('model proxy control secret is required');
  const leases = new Map<string, CompanyModelLease>();
  const controllers = new Map<string, Set<AbortController>>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const revoke = (id: string) => {
    leases.delete(id);
    clearTimeout(expiryTimers.get(id));
    expiryTimers.delete(id);
    for (const controller of controllers.get(id) ?? []) controller.abort();
    controllers.delete(id);
  };
  const now = options.now ?? Date.now;
  const server = createServer(async (req, res) => {
    const fail = (status: number, error: string) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify({error})); };
    try {
      const requestUrl = new URL(req.url ?? '/', 'http://proxy');
      const pathname = requestUrl.pathname;
      const credential = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] ?? '');
      if (pathname.startsWith('/control/')) {
        if (!equal(credential, options.controlSecret)) return fail(401, 'unauthorized');
        if (req.method === 'DELETE' && pathname.startsWith('/control/leases/')) {
          revoke(decodeURIComponent(pathname.slice('/control/leases/'.length)));
          res.writeHead(204); res.end(); return;
        }
        if (req.method !== 'POST' || pathname !== '/control/leases') return fail(404, 'not found');
        const body = await jsonBody(req);
        if (!['id','token','agentId','model','baseUrl','apiKey'].every(k => typeof body[k] === 'string' && (body[k] as string).length > 0)
          || !['codex','claude','opencode','deepseek-harness'].includes(String(body.agentId))
          || !['openai','anthropic'].includes(String(body.protocol))
          || (body.wireProtocol !== undefined && !['responses','chat-completions','anthropic-messages'].includes(String(body.wireProtocol)))
          || (body.maxTokens !== undefined && (typeof body.maxTokens !== 'number' || !Number.isInteger(body.maxTokens) || body.maxTokens < 1024 || body.maxTokens > 200000))
          || typeof body.expiresAt !== 'number' || body.expiresAt <= now()) return fail(400, 'invalid lease');
        const base = new URL(String(body.baseUrl));
        if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return fail(400, 'invalid upstream');
        const id = String(body.id);
        revoke(id);
        leases.set(id, body as unknown as CompanyModelLease);
        const timer = setTimeout(() => revoke(id), Math.min(body.expiresAt - now(), 2_147_483_647));
        timer.unref(); expiryTimers.set(id,timer);
        res.writeHead(201); res.end('{}'); return;
      }
      const bridge = pathname.startsWith('/od/api/');
      if (!bridge && !/^\/v1\/(responses(?:\/[A-Za-z0-9_-]+)?|chat\/completions|messages|models)$/.test(pathname)) return fail(404, 'not found');
      for (const [id, lease] of leases) if (lease.expiresAt <= now()) revoke(id);
      const lease = [...leases.values()].find(candidate => equal(candidate.token, credential));
      if (!lease) return fail(401, 'expired or unknown task');
      if (bridge) {
        const project = /^\/od\/api\/projects\/([^/]+)\/(?:files(?:\/.*)?|raw\/.*|preview(?:\/.*)?|export(?:\/.*)?|folders|search)$/.exec(pathname);
        const catalog = req.method === 'GET' && /^\/od\/api\/(?:skills|design-systems|design-templates|craft|prompt-templates)(?:\/[^?#]*)?$/.test(pathname);
        const tool = /^\/od\/api\/tools\/(?:live-artifacts\/(?:create|list|update|refresh)|design-systems\/read|deliverable-syntax\/check)$/.test(pathname);
        if (!options.daemonOrigin || (!catalog && !(tool && lease.projectId) && (!project || !lease.projectId || decodeURIComponent(project[1]!) !== lease.projectId))) return fail(403, 'task resource not allowed');
      } else {
        if (req.method !== 'POST' && !(req.method === 'GET' && pathname === '/v1/models')) return fail(405, 'method not allowed');
        if (lease.protocol === 'anthropic' ? !['/v1/messages','/v1/models'].includes(pathname) : pathname === '/v1/messages') return fail(403, 'protocol not allowed');
        if (lease.wireProtocol && pathname !== '/v1/models') {
          const expected = { responses:'/v1/responses', 'chat-completions':'/v1/chat/completions', 'anthropic-messages':'/v1/messages' }[lease.wireProtocol];
          if (pathname !== expected) return fail(403, 'protocol not allowed');
        }
      }
      const body = !['GET','HEAD'].includes(req.method ?? 'GET') ? await jsonBody(req) : undefined;
      if (!bridge && body && body.model !== undefined && body.model !== lease.model) return fail(403, 'model not allowed');
      if (!bridge && body) body.model = lease.model;
      if (!bridge && body && lease.maxTokens !== undefined) {
        const field = pathname === '/v1/responses' ? 'max_output_tokens'
          : pathname === '/v1/chat/completions' && body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
        const requested = body[field];
        body[field] = typeof requested === 'number' && Number.isInteger(requested) && requested > 0
          ? Math.min(requested, lease.maxTokens) : lease.maxTokens;
      }
      const headers: Record<string,string> = {'content-type':'application/json',accept:String(req.headers.accept ?? 'application/json')};
      if (bridge) headers.authorization = `Bearer ${lease.token}`;
      else if (lease.protocol === 'anthropic') {
        headers['x-api-key'] = lease.apiKey;
        headers['anthropic-version'] = String(req.headers['anthropic-version'] ?? '2023-06-01');
        if (typeof req.headers['anthropic-beta'] === 'string') headers['anthropic-beta'] = req.headers['anthropic-beta'];
        // Preserve genuine CLI metadata without forwarding task or control credentials.
        for (const name of ['user-agent', 'x-app', 'x-claude-code-session-id', 'anthropic-dangerous-direct-browser-access',
          'x-stainless-arch', 'x-stainless-lang', 'x-stainless-os', 'x-stainless-package-version',
          'x-stainless-retry-count', 'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-timeout']) {
          if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
        }
      } else headers.authorization = `Bearer ${lease.apiKey}`;
      const upstreamPath = `${bridge ? pathname.slice('/od'.length) : pathname.slice('/v1'.length)}${requestUrl.search}`;
      const base = (bridge ? options.daemonOrigin! : lease.baseUrl).replace(/\/$/, '');
      const controller = new AbortController();
      const active = controllers.get(lease.id) ?? new Set<AbortController>();
      controllers.set(lease.id, active); active.add(controller);
      res.once('close', () => { controller.abort(); active.delete(controller); if (!active.size) controllers.delete(lease.id); });
      const response = await fetch(`${base}${upstreamPath}`, {method:req.method ?? 'POST',headers,...(body ? {body:JSON.stringify(body)} : {}),signal:controller.signal,redirect:'error'});
      if (!bridge && !response.ok) {
        await response.body?.cancel();
        res.writeHead(response.status,{'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify({type:'error',error:{type:'upstream_error',code:`upstream_http_${response.status}`,message:`Model service returned HTTP ${response.status}; contact the administrator to check its configuration`}}));
        return;
      }
      res.writeHead(response.status, {'content-type':response.headers.get('content-type') ?? 'application/json','cache-control':'no-store'});
      if (response.body) {
        for await (const chunk of response.body) {
          if (res.destroyed || !leases.has(lease.id) || lease.expiresAt <= now()) { controller.abort(); break; }
          if (!res.write(chunk)) await new Promise<void>(resolve => { res.once('drain',resolve); res.once('close',resolve); });
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) fail(502, 'model service request failed');
      else res.end();
    }
  });
  server.once('close', () => { for (const id of leases.keys()) revoke(id); });
  return server;
}

export async function registerCompanyModelLease(origin: string, secret: string, lease: CompanyModelLease): Promise<void> {
  const result = await fetch(`${origin}/control/leases`, {method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(lease),signal:AbortSignal.timeout(10000)});
  if (!result.ok) throw new Error('unable to authorize model task');
}
export async function revokeCompanyModelLease(origin: string, secret: string, id: string): Promise<void> {
  const result = await fetch(`${origin}/control/leases/${encodeURIComponent(id)}`, {method:'DELETE',headers:{authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(10000)});
  if (!result.ok) throw new Error('unable to revoke model task');
}
