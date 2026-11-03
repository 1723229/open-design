import type {Express} from 'express';
import {readBrandDetail} from '../brands/index.js';
import {getProject,updateProject} from '../db.js';
import {companyRequestIsWrite} from './policy.js';
import {getCompanyTask,type CompanyRuntime} from './routes.js';
import type {CompanyResources} from './resources.js';
import type {BrandSummary} from '@open-design/contracts';

/** Keep the original brand extraction workflow behind company project ownership. */
export function registerCompanyBrandRoutes(app:Express,{company,resources,brandsRoot}:{company:CompanyRuntime;resources:CompanyResources;brandsRoot:string}):void {
  app.use((req,res,next)=>{
    const match=/^\/api\/brands(?:\/([^/]+)(?:\/.*)?)?$/u.exec(req.path);
    if(!match) return next();
    const actor=company.getUser(req),task=getCompanyTask(req);
    if(!actor) return void res.status(401).json({error:'Authentication required'});
    const id=match[1],write=companyRequestIsWrite(req);
    if(id) {
      const detail=readBrandDetail(brandsRoot,decodeURIComponent(id));
      if(!detail) return void res.status(404).json({error:'brand not found'});
      const projectId=detail.meta.projectId;
      if(!projectId || (task && task.projectId!==projectId) || !company.store.canAccess(actor,projectId,write)
        || (req.method==='DELETE' && !company.store.canManage(actor,projectId))
        || (req.body?.projectId!==undefined && req.body.projectId!==projectId)) {
        return void res.status(403).json({error:'Brand project access denied'});
      }
      return next();
    }
    const json=res.json.bind(res);
    if(req.method==='GET') {
      res.json=value=>json({...value,brands:(value.brands ?? []).filter((brand:BrandSummary)=>{
        const projectId=brand.meta.projectId;
        return projectId && company.store.canAccess(actor,projectId);
      })});
    } else if(req.method==='POST') {
      const context=resources.context(actor,req.get('x-od-workspace-id'));
      res.json=value=>{
        if(res.statusCode<300 && typeof value?.projectId==='string') {
          if(context.workspaceType==='team') req.body.companyTeamId=context.workspaceId;
          company.claimProject(req,value.projectId);
          const project=getProject(company.store.database,value.projectId);
          updateProject(company.store.database,value.projectId,{metadata:{...project?.metadata,localCatalogScopes:{designSystem:{workspaceId:context.workspaceId,workspaceMemberId:actor.id}}}});
        }
        return json(value);
      };
    }
    next();
  });
}
