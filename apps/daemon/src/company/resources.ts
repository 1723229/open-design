import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {CompanyUser,WorkspaceCollabContext} from '@open-design/contracts';
import {getWorkspaceResourceByResourceId,getProject} from '../db.js';
import {TeamResourceShareForbiddenError,type TeamResourceRequestScope,type TeamResourceShareRecord,type TeamResourceShareService} from '../collab/team-resource-share.js';
import type {WorkspaceResourceContext} from '../collab/workspace-resource-mutation.js';
import type {CompanyStore} from './store.js';

type Kind='design_system'|'plugin'|'skill';
interface Version {id:string;workspace_id:string;kind:Kind;resource_id:string;owner_id:string;version:number;title:string|null;description:string|null}
interface ShareOptions {kind:Kind;resolveDir:(id:string)=>string|Promise<string>;describeResource?:(id:string)=>Record<string,unknown>|null|Promise<Record<string,unknown>|null>}

/** Local transport for the original resource sharing and materialization contracts. */
export class CompanyResources {
  constructor(private readonly store:CompanyStore,private readonly dataRoot:string) {
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS company_resource_versions (
        id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES company_teams(id),kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES company_users(id),version INTEGER NOT NULL,
        title TEXT,description TEXT,UNIQUE(workspace_id,kind,resource_id,version)
      );
      CREATE TABLE IF NOT EXISTS company_resource_publications (
        workspace_id TEXT NOT NULL REFERENCES company_teams(id),kind TEXT NOT NULL,resource_id TEXT NOT NULL,
        version_id TEXT NOT NULL REFERENCES company_resource_versions(id),PRIMARY KEY(workspace_id,kind,resource_id)
      );
    `);
  }
  context(actor:Pick<CompanyUser,'id'>,workspaceId?:string|null):WorkspaceCollabContext & WorkspaceResourceContext {
    const user=this.store.getUser(actor.id);
    if(!user || user.disabled || user.mustChangePassword) throw new TeamResourceShareForbiddenError();
    const personal=`company-personal:${user.id}`;
    const team=workspaceId && workspaceId!==personal ? this.store.teams.get(workspaceId,user) : null;
    if(workspaceId && workspaceId!==personal && !team) throw new TeamResourceShareForbiddenError();
    const writable=team ? team.canWrite : true;
    const role=team ? user.role==='admin'?'admin':team.role==='owner'?'owner':team.role==='admin'?'admin':'member' : 'owner';
    const workspaceType=team?'team':'personal';
    return {
      identitySource:'company',workspaceId:team?.id ?? personal,workspaceType,workspaceTypeAsserted:workspaceType,
      workspaceMemberId:user.id,appUserId:user.id,role,memberStatus:'active',lifecycleState:team?.status==='archived'?'locked':'active',
      billingState:'inactive',planId:null,providerMode:'personal_byok',seatSummary:{seatLimit:0,usedSeats:0,availableSeats:0,isSeatFull:false},
      canShareProjects:Boolean(team && writable),canWriteSyncedFiles:writable,
      permissions:{canManageMembers:false,canManageBilling:false,canInviteMembers:false,canManageAutoRecharge:false,
        canShareProjects:Boolean(team && writable),canWriteSyncedFiles:writable,canViewWorkspaceSettings:false,
        canManageSharedResources:Boolean(team?.canManage && writable)},
      displayName:user.displayName ?? user.username,workspaceName:team?.name ?? user.username,
      ...(team?{teamId:team.id,teamName:team.name}:{}),
    };
  }
  private scope(scope:TeamResourceRequestScope) {
    return this.context({id:scope.principal.memberId},scope.principal.teamId);
  }
  selectionContext(actor:Pick<CompanyUser,'id'>,projectId:string,kind:'skill'|'designSystem'|'plugin') {
    if(!this.store.canAccess(actor,projectId)) throw new TeamResourceShareForbiddenError();
    const teamId=this.store.teams.projectTeamId(projectId);
    if(teamId) return this.context(actor,teamId);
    const scopes=getProject(this.store.database,projectId)?.metadata?.localCatalogScopes;
    const staged=kind==='plugin' ? scopes?.skill ?? scopes?.designSystem : scopes?.[kind];
    return this.context(actor,staged?.workspaceId);
  }
  private rows(kind:Kind,workspaceId:string):Version[] {
    return this.store.database.prepare(`SELECT v.* FROM company_resource_publications p
      JOIN company_resource_versions v ON v.id=p.version_id WHERE p.workspace_id=? AND p.kind=? ORDER BY v.resource_id`)
      .all(workspaceId,kind) as Version[];
  }
  isPublished(kind:string,resourceId:string,workspaceId:string):boolean {
    return Boolean(this.store.database.prepare('SELECT 1 FROM company_resource_publications WHERE workspace_id=? AND kind=? AND resource_id=?').get(workspaceId,kind,resourceId));
  }
  private directory(id:string):string {
    if(!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Invalid resource version');
    return path.join(this.dataRoot,'company-resource-publications',id);
  }
  private withinRoot(value:string):void {
    const relative=path.relative(path.resolve(this.dataRoot),path.resolve(value));
    if(relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Resource must remain under the daemon data root');
  }
  private async copy(source:string,target:string,staged=false):Promise<void> {
    this.withinRoot(await fs.realpath(source));this.withinRoot(target);
    await fs.mkdir(path.dirname(target),{recursive:true});
    if(staged) {
      const existing=await fs.lstat(target).catch(error=>{if(error.code!=='ENOENT') throw error;return null;});
      if(existing) {
        this.withinRoot(await fs.realpath(target));
        if(!existing.isDirectory() || existing.isSymbolicLink() || (await fs.readdir(target)).length) throw new Error('Resource staging directory must be empty');
      }
    }
    await fs.cp(source,target,{recursive:true,force:false,errorOnExist:!staged,filter:async source=>{
      if((await fs.lstat(source)).isSymbolicLink()) throw new Error('Shared resource cannot contain symbolic links');
      return true;
    }});
  }
  publications(kind:Kind,scope:TeamResourceRequestScope):TeamResourceShareRecord[] {
    const context=this.scope(scope);
    if(context.workspaceType!=='team') return [];
    return this.rows(kind,context.workspaceId).map(row=>({id:row.resource_id,hubResourceId:row.id,
      ownerMemberId:row.owner_id,version:row.version,versionId:row.id,
      canUnshare:context.permissions.canWriteSyncedFiles && (row.owner_id===context.workspaceMemberId || context.permissions.canManageSharedResources),
      ...(row.title?{title:row.title}:{}),...(row.description?{description:row.description}:{}),
    }));
  }
  shareService(options:ShareOptions):TeamResourceShareService {
    const list=async(scope:TeamResourceRequestScope)=>this.publications(options.kind,scope);
    return {
      configured:true,sharedResources:list,sharedIds:async scope=>(await list(scope)).map(row=>row.id),
      isShared:(id,scope)=>this.rows(options.kind,this.scope(scope).workspaceId).some(row=>row.resource_id===id),
      share:async(id,scope)=>{
        const authorize=()=>{
          const context=this.scope(scope),binding=getWorkspaceResourceByResourceId(this.store.database,options.kind,id);
          if(!context.permissions.canShareProjects || !binding || binding.workspaceId!==context.workspaceId
            || binding.resourceState!=='active' || binding.visibility!=='personal' || binding.createdByWorkspaceMemberId!==context.workspaceMemberId) throw new TeamResourceShareForbiddenError();
          return context;
        };
        authorize();
        const versionId=randomUUID(),directory=this.directory(versionId);
        try {
          await this.copy(await options.resolveDir(id),directory);
          const metadata=await options.describeResource?.(id);
          const version=this.store.database.transaction(()=>{
            const context=authorize();
            const previous=this.store.database.prepare('SELECT MAX(version) AS version FROM company_resource_versions WHERE workspace_id=? AND kind=? AND resource_id=?')
              .get(context.workspaceId,options.kind,id) as {version:number|null};
            const version=(previous.version ?? 0)+1;
            this.store.database.prepare('INSERT INTO company_resource_versions VALUES (?,?,?,?,?,?,?,?)').run(versionId,context.workspaceId,options.kind,id,context.workspaceMemberId,version,
              typeof metadata?.title==='string'?metadata.title:null,typeof metadata?.description==='string'?metadata.description:null);
            this.store.database.prepare(`INSERT INTO company_resource_publications VALUES (?,?,?,?) ON CONFLICT(workspace_id,kind,resource_id) DO UPDATE SET version_id=excluded.version_id`)
              .run(context.workspaceId,options.kind,id,versionId);
            this.store.audit(context.workspaceMemberId,'resource.shared',`${context.workspaceId}/${options.kind}/${id}`);
            return version;
          })();
          return {version};
        } catch(error) {await fs.rm(directory,{recursive:true,force:true});throw error;}
      },
      unshare:async(id,scope)=>{
        const context=this.scope(scope),row=this.rows(options.kind,context.workspaceId).find(row=>row.resource_id===id);
        if(!context.permissions.canWriteSyncedFiles || (row && row.owner_id!==context.workspaceMemberId && !context.permissions.canManageSharedResources)) throw new TeamResourceShareForbiddenError();
        const result=this.store.database.prepare('DELETE FROM company_resource_publications WHERE workspace_id=? AND kind=? AND resource_id=?').run(context.workspaceId,options.kind,id);
        if(result.changes) this.store.audit(context.workspaceMemberId,'resource.unshared',`${context.workspaceId}/${options.kind}/${id}`);
        return Boolean(result.changes);
      },
    };
  }
  async pull(request:{workspaceId:string;kind:Kind;resourceId:string;dir:string}):Promise<void> {
    const version=this.store.database.prepare(`SELECT v.* FROM company_resource_versions v JOIN company_resource_publications p
      ON p.version_id=v.id WHERE v.workspace_id=? AND v.kind=? AND v.id=?`).get(request.workspaceId,request.kind,request.resourceId) as Version|undefined;
    if(!version) throw new Error('Published resource is no longer available');
    await this.copy(this.directory(version.id),request.dir,true);
  }
}
