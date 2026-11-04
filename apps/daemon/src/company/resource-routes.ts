import type {Express,Request} from 'express';
import type {CompanyRuntime} from './routes.js';
import {getCompanyTask} from './routes.js';
import {companyRequestIsWrite,companyResourceRequest} from './policy.js';
import {getTemplate,listTemplates,getWorkspaceResourceByResourceId} from '../db.js';
import type {CompanyResources} from './resources.js';

const PRINCIPAL=Symbol('company-resource-principal');
type ScopedRequest=Request & {[PRINCIPAL]?:{userId:string;projectId?:string}};

/** Re-verify the real local user, including wrappers made by the original navigation helpers. */
export function companyResourceAuthority(req:Request,company:CompanyRuntime,resources:CompanyResources) {
  try {
    const task=getCompanyTask(req),stamped=(req as ScopedRequest)[PRINCIPAL];
    const actor=company.getUser(req) ?? company.store.getUser(task?.userId ?? stamped?.userId ?? '');
    if(!actor) throw new Error('Authentication required');
    const selectors=[req.get('x-nexus-resource-workspace-id'),req.query?.companyWorkspaceId,req.get('x-od-workspace-id'),req.query?.workspaceId].filter(Boolean).map(String);
    if(new Set(selectors).size>1) throw new Error('Conflicting resource selectors');
    const claimed=selectors[0] ?? '';
    const members=[req.get('x-nexus-resource-member-id'),req.query?.companyMemberId,req.get('x-od-workspace-member-id'),req.query?.workspaceMemberId].filter(Boolean).map(String);
    if(members.some(member=>member!==actor.id)) throw new Error('Member selector does not match the authenticated user');
    const projectId=task?.projectId ?? stamped?.projectId;
    const kind=/\/(?:design-systems|brands)(?:\/|$)/u.test(req.path)?'designSystem':req.path.includes('/skills')?'skill':'plugin';
    const projectScope=projectId?resources.selectionContext(actor,projectId,kind).workspaceId:undefined;
    if(projectScope && claimed && claimed!==projectScope) throw new Error('Task resource scope does not match its project');
    return {ok:true as const,context:resources.context(actor,claimed || projectScope)};
  } catch {
    return {ok:false as const,status:403 as const,code:'WORKSPACE_ACCESS_DENIED',message:'Resource access denied or team permissions expired'};
  }
}

export function registerCompanyResourceRoutes(app:Express,{company,resources}:{company:CompanyRuntime;resources:CompanyResources}):void {
  if(!company.enabled) return;
  app.get('/api/templates',(req,res)=>{
    const actor=company.getUser(req);
    if(!actor) return void res.status(401).json({error:'Authentication required'});
    res.json({templates:listTemplates(company.store.database).filter(template=>actor.role==='admin'
      || (template.sourceProjectId && company.store.canAccess(actor,template.sourceProjectId)))
      .map(template=>({...template,canDelete:actor.role==='admin' || Boolean(template.sourceProjectId && company.store.canManage(actor,template.sourceProjectId))}))});
  });
  app.use((req,res,next)=>{
    const templateRoute=/^\/api\/templates(?:\/([^/]+))?$/u.exec(req.path);
    if(!templateRoute) return next();
    const actor=company.getUser(req);
    if(!actor) return void res.status(401).json({error:'Authentication required'});
    if(templateRoute[1]) {
      const template=getTemplate(company.store.database,decodeURIComponent(templateRoute[1]));
      if(!template) return void res.status(404).json({error:'Template not found'});
      if(actor.role!=='admin' && (!template.sourceProjectId || !company.store.canAccess(actor,template.sourceProjectId)
        || (companyRequestIsWrite(req) && !company.store.canManage(actor,template.sourceProjectId)))) {
        return void res.status(403).json({error:'Template access denied'});
      }
    } else if(req.method==='POST' && (typeof req.body?.sourceProjectId!=='string' || !company.store.canAccess(actor,req.body.sourceProjectId,true))) {
      return void res.status(403).json({error:'Source project access denied'});
    }
    next();
  });
  app.get('/api/company/resources/context',(req,res)=>{
    const actor=company.getUser(req);
    if(!actor) return void res.status(401).json({error:'Authentication required'});
    try {
      let workspaceId=typeof req.query.teamId==='string'?req.query.teamId:undefined;
      if(typeof req.query.projectId==='string') {
        if(!company.store.canAccess(actor,req.query.projectId)) throw new Error('Project access denied');
        const projectScope=resources.selectionContext(actor,req.query.projectId,'plugin').workspaceId;
        if(workspaceId && workspaceId!==projectScope) throw new Error('Project scope mismatch');
        workspaceId=projectScope;
      }
      if(typeof req.query.resourceId==='string' && typeof req.query.kind==='string') {
        const binding=getWorkspaceResourceByResourceId(company.store.database,req.query.kind,req.query.resourceId);
        if(binding) {
          if(workspaceId && workspaceId!==binding.workspaceId) throw new Error('Resource scope mismatch');
          workspaceId=binding.workspaceId;
          if(binding.visibility==='personal' && binding.createdByWorkspaceMemberId!==actor.id && actor.role!=='admin'
            && !resources.isPublished(req.query.kind,req.query.resourceId,binding.workspaceId)) throw new Error('Private resource');
        }
      }
      res.json({context:resources.context(actor,workspaceId)});
    } catch {res.status(403).json({error:'Resource access denied or team permissions expired'});}
  });
  app.use((req,res,next)=>{
    if(req.method==='POST' && req.path==='/api/projects') {
      const actor=company.getUser(req);
      if(!actor) return void res.status(401).json({error:'Authentication required'});
      try {
        if(req.body?.metadata?.kind==='template' && typeof req.body.metadata.templateId==='string') {
          const template=getTemplate(company.store.database,req.body.metadata.templateId);
          if(!template || (actor.role!=='admin' && (!template.sourceProjectId || !company.store.canAccess(actor,template.sourceProjectId)))) throw new Error('Template is unavailable');
        }
        if(typeof req.body?.appliedPluginSnapshotId==='string') {
          const source=company.store.database.prepare('SELECT project_id AS projectId FROM applied_plugin_snapshots WHERE id=?').get(req.body.appliedPluginSnapshotId) as {projectId:string}|undefined;
          if(!source || !company.store.canAccess(actor,source.projectId)) throw new Error('Plugin snapshot is unavailable');
        }
        const selected=typeof req.body?.companyTeamId==='string'?req.body.companyTeamId:req.get('x-nexus-resource-workspace-id');
        const context=resources.context(actor,selected);
        const hint=req.get('x-nexus-resource-workspace-id');
        if(hint && hint!==context.workspaceId) throw new Error('Conflicting resource selection');
        const scope={workspaceId:context.workspaceId,workspaceMemberId:actor.id};
        req.body.skillCatalogScope=scope;req.body.designSystemCatalogScope=scope;
      } catch {return void res.status(403).json({error:'Resource selection belongs to an unavailable space'});}
      return next();
    }
    if(!companyResourceRequest(req)) return next();
    const actor=company.getUser(req),task=getCompanyTask(req);
    if(!actor && !task) return void res.status(401).json({error:'Authentication required'});
    const principal=actor ?? company.store.getUser(task!.userId)!;
    if(!principal) return void res.status(403).json({error:'Resource access denied'});
    const resolution=companyResourceAuthority(req,company,resources);
    if(!resolution.ok) return void res.status(resolution.status).json({error:resolution.message,code:resolution.code});
    const context=resolution.context;
    // Applying an existing plugin only computes its prompt; the original route
    // verifies visibility and, for apply-local, the exact catalogue source.
    const appliesExistingPlugin=req.method==='POST' && /^\/api\/plugins\/[^/]+\/(?:apply|apply-local)$/u.test(req.path);
    if(companyRequestIsWrite(req) && !appliesExistingPlugin && !context.permissions.canWriteSyncedFiles) return void res.status(403).json({error:'This resource space is read-only'});
    if(companyRequestIsWrite(req) && !appliesExistingPlugin && principal.role!=='admin' && typeof req.body?.source==='string'
      && (/^(?:[a-zA-Z]:[\\/]|[./~\\]|file:)/u.test(req.body.source) || req.body.source.includes('..'))) {
      return void res.status(403).json({error:'Server filesystem imports require administrator access'});
    }
    Object.defineProperty(req,PRINCIPAL,{value:{userId:principal.id,...(task?{projectId:task.projectId}:{})},enumerable:true});
    Object.assign(req.headers,{
      'x-od-workspace-id':context.workspaceId,'x-od-workspace-member-id':context.workspaceMemberId,'x-od-app-user-id':principal.id,
      'x-od-workspace-type':context.workspaceType,'x-od-workspace-role':context.role,
      'x-od-workspace-lifecycle-state':context.lifecycleState,'x-od-workspace-member-status':context.memberStatus,
      'x-od-workspace-can-share-projects':String(context.permissions.canShareProjects),
      'x-od-workspace-can-write-synced-files':String(context.permissions.canWriteSyncedFiles),
    });
    next();
  });
}
