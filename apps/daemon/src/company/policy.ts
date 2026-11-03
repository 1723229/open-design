import type { Request } from 'express';

export interface CompanyRequestPolicy {
  allowed: boolean;
  projectId?: string;
  write: boolean;
  ownerOnly?: boolean;
  comment?: boolean;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function companyRequestIsWrite(req: Request): boolean { return !READ_METHODS.has(req.method); }

export function companyResourceRequest(req: Pick<Request,'path'>): boolean {
  return /^\/api\/(?:design-systems|design-templates|skills|plugins|brands)(?:\/|$)/u.test(req.path)
    || /^\/api\/workspace\/(?:design-systems|skills|plugins)(?:\/|$)/u.test(req.path)
    || req.path === '/api/workspace/events';
}

export function companyMemberProjectPatchAllowed(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['name', 'description', 'pinned', 'pendingPrompt', 'metadata','skillId','designSystemId'].includes(key))
    || ('pendingPrompt' in body && body.pendingPrompt !== null)) return false;
  if(['skillId','designSystemId'].some(key=>key in body && body[key]!==null && typeof body[key]!=='string')) return false;
  if (!('metadata' in body)) return true;
  const metadata = body.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  return Object.entries(metadata).every(([key, item]) => typeof item === 'string' && (
    (key === 'kind' && ['prototype', 'deck', 'template', 'other', 'brand', 'image', 'video', 'audio'].includes(item))
    || (key === 'nameSource' && ['generated', 'prompt', 'agent', 'user'].includes(item))
  ));
}

/** Members receive an explicit product surface; new endpoints stay administrator-only. */
export function companyMemberPolicy(req: Request, resolveRunProjectId?: (runId: string) => string | null): CompanyRequestPolicy {
  const pathname = req.path;
  if(req.method==='GET' && pathname==='/api/company/tasks') return {allowed:true,write:false};
  const write = companyRequestIsWrite(req);
  const deny = { allowed: false, write };
  const global = { allowed: true, write };
  if (pathname.startsWith('/api/company/')) return global; // Domain router enforces administration/sharing rules.
  if (companyResourceRequest(req)) return global; // The resource adapter verifies scope; original resource routes enforce ownership.
  if (pathname === '/api/projects' && ['GET', 'HEAD', 'POST'].includes(req.method)) {
    if (req.method === 'POST') {
      const body = req.body as Record<string, unknown> | undefined;
      const metadata = body?.metadata;
      if (body?.projectLocationId || ['cwd', 'workingDir', 'agentCliEnv'].some((key) => body && key in body)) return deny;
      if (metadata && typeof metadata === 'object' && ['baseDir', 'originalBaseDir', 'importedFrom', 'fromTrustedPicker', 'orchestratorWorkspace', 'linkedDirs'].some((key) => key in metadata)) return deny;
    }
    return global;
  }
  // The composition root returns only managed public model preferences on these reads.
  if (!write && ['/api/app-config', '/api/config', '/api/agents', '/api/workspace/directory', '/api/plugins', '/api/marketplaces'].includes(pathname)) return global;
  if (!write && /^\/api\/(?:version|ready|templates(?:\/[^/]+)?|skills(?:\/[^/]+(?:\/(?:example|assets\/.*))?)?|design-templates(?:\/[^/]+)?|design-systems(?:\/[^/]+(?:\/(?:files|file|archive))?)?|atoms(?:\/[^/]+)?|craft(?:\/[^/]+)?|prompt-templates(?:\/[^/]+\/[^/]+)?)$/u.test(pathname)) return global;
  if (!write && pathname.startsWith('/frames/')) return global;
  if (/^\/api\/live-artifacts(?:\/[^/]+(?:\/(?:preview|refreshes|refresh))?)?$/u.test(pathname)) {
    const projectId=typeof req.query.projectId==='string'?req.query.projectId:'';
    return projectId ? {allowed:true,projectId,write} : deny;
  }
  const project = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/u.exec(pathname);
  if (project) {
    const projectId = decodeURIComponent(project[1]!);
    const rest = project[2] ?? '';
    if (write && /^conversations\/[^/]+\/comments(?:\/(?!pull$)[^/]+(?:\/(?:anchor|reorder))?)?$/u.test(rest)) {
      return {allowed:true,projectId,write:false,comment:true};
    }
    if (/^(?:export(?:\/.*)?|archive(?:\/batch)?)$/u.test(rest)) {
      return ['GET', 'HEAD', 'OPTIONS', 'POST'].includes(req.method) ? { allowed: true, projectId, write: false } : deny;
    }
    if (rest === 'upload') return req.method === 'POST' ? { allowed: true, projectId, write: true } : deny;
    if (rest === 'workspace-scope') return !write ? { allowed: true, projectId, write: false } : deny;
    if (rest === 'share-state') return req.method === 'GET' ? { allowed: true, projectId, write: false } : deny;
    if (/^preview\/[A-Za-z0-9_-]+\/renew$/u.test(rest)) return req.method === 'POST' ? {allowed:true,projectId,write:false} : deny;
    if (!/^(?:|duplicate|files(?:\/.*)?|raw\/.*|powered\/.*|text-preview\/.*|preview(?:\/.*)?|preview-url|folders|search|tabs|conversations(?:\/.*)?|submissions|events|workspace-artifacts\/[^/]+|chat-artifact-snapshots\/[^/]+(?:\/(?:content|thumbnail))?|comments\/read|design-token-suggestions|critique\/[^/]+\/(?:artifact|interrupt))$/u.test(rest)) return deny;
    if (!rest && req.method === 'PATCH') {
      // Arbitrary project metadata carries host paths, runtime settings, and instructions.
      if (!companyMemberProjectPatchAllowed(req.body)) return deny;
    }
    return { allowed: true, projectId, write: rest === 'tabs' || rest === 'comments/read' ? false : write, ...(!rest && req.method === 'DELETE' ? { ownerOnly: true } : {}) };
  }
  if (['/api/runs', '/api/chat'].includes(pathname) && req.method === 'POST') {
    return typeof req.body?.projectId === 'string' && req.body.projectId ? { allowed: true, projectId: req.body.projectId, write: true } : deny;
  }
  if (pathname === '/api/runs' && !write) {
    return typeof req.query.projectId === 'string' && req.query.projectId ? { allowed: true, projectId: req.query.projectId, write: false } : deny;
  }
  const run = /^\/api\/runs\/([^/]+)(?:\/(?:events|agui|result-package|cancel|steer|feedback))?$/u.exec(pathname);
  if (run) {
    const projectId = resolveRunProjectId?.(decodeURIComponent(run[1]!));
    return projectId ? { allowed: true, projectId, write } : deny;
  }
  // Unscoped artifacts may belong to another project. The project files API is the authorized path.
  return deny;
}

/** Signed execution credentials are narrower than the actor's interactive session. */
export function companyTaskPolicy(req: Request, projectId: string): boolean {
  // The company brand adapter checks the backing project for every named brand.
  if (/^\/api\/brands\/[^/]+(?:\/(?:preview|finalize|extract-from-html|logo))?$/u.test(req.path)) return true;
  if (/^\/api\/tools\/(?:live-artifacts\/(?:create|list|update|refresh)|design-systems\/read|deliverable-syntax\/check)$/u.test(req.path)) return true;
  const project = /^\/api\/projects\/([^/]+)\/(files(?:\/.*)?|raw\/.*|text-preview\/.*|powered\/.*|preview(?:\/.*)?|preview-url|folders|search|export(?:\/.*)?)$/u.exec(req.path);
  if (project) return decodeURIComponent(project[1]!) === projectId;
  return !companyRequestIsWrite(req) && /^\/api\/(?:skills(?:\/[^/]+(?:\/(?:example|assets\/.*))?)?|design-templates(?:\/[^/]+)?|design-systems(?:\/[^/]+(?:\/(?:files|file|archive))?)?|atoms(?:\/[^/]+)?|craft(?:\/[^/]+)?)$/u.test(req.path);
}
