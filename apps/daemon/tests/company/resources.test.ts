import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,closeDatabase,ensureWorkspaceResource,insertProject} from '../../src/db.js';
import {CompanyStore} from '../../src/company/store.js';
import {CompanyResources} from '../../src/company/resources.js';
import {teamResourceRequestScopeFromContext} from '../../src/collab/team-resource-share.js';

const directories:string[]=[];
afterEach(()=>{closeDatabase();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(path.join(tmpdir(),'od-company-resources-'));directories.push(root);
  const db=openDatabase(root,{dataDir:root}),store=new CompanyStore(db);
  const owner=store.upsertLdapUser({entryUUID:'owner',username:'owner'}),viewer=store.upsertLdapUser({entryUUID:'viewer',username:'viewer'}),other=store.upsertLdapUser({entryUUID:'other',username:'other'});
  const team=store.teams.create('A',owner),otherTeam=store.teams.create('B',other);
  store.teams.setMember(team.id,viewer.id,'viewer',owner);
  const source=path.join(root,'skill-source');mkdirSync(source);writeFileSync(path.join(source,'SKILL.md'),'original');
  ensureWorkspaceResource(db,'skill',team.id,'skill-a',{visibility:'personal',resourceState:'active',createdByWorkspaceMemberId:owner.id});
  const resources=new CompanyResources(store,root);
  const service=resources.shareService({kind:'skill',resolveDir:()=>source,describeResource:()=>({title:'Review skill'})});
  const scope=(actor:typeof owner,teamId:string)=>teamResourceRequestScopeFromContext(resources.context(actor,teamId))!;
  return {root,db,store,owner,viewer,other,team,otherTeam,source,resources,service,scope};
}

it('derives resource scope from actual local membership and keeps reviewers read only',()=>{
  const f=fixture(),ctx=f.resources.context(f.viewer,f.team.id);
  expect(ctx).toMatchObject({workspaceId:f.team.id,workspaceMemberId:f.viewer.id,permissions:{canShareProjects:false,canWriteSyncedFiles:false,canManageBilling:false}});
  expect(()=>f.resources.context(f.viewer,f.otherTeam.id)).toThrow();
  expect(f.resources.context(f.owner).workspaceId).not.toBe(f.team.id);
  f.store.teams.update(f.team.id,{status:'archived'},f.owner);
  expect(f.resources.context(f.owner,f.team.id).permissions.canWriteSyncedFiles).toBe(false);
});

it('publishes immutable local snapshots through the original sharing contract and persists across restart',async()=>{
  const f=fixture(),scope=f.scope(f.owner,f.team.id);
  expect(await f.service.share('skill-a',scope)).toEqual({version:1});
  writeFileSync(path.join(f.source,'SKILL.md'),'unpublished draft');
  const shared=await f.service.sharedResources(f.scope(f.viewer,f.team.id));
  expect(shared).toMatchObject([{id:'skill-a',title:'Review skill',ownerMemberId:f.owner.id,canUnshare:false,version:1}]);
  const target=path.join(f.root,'materialized');
  await f.resources.pull({workspaceId:f.team.id,kind:'skill',resourceId:shared[0]!.hubResourceId!,dir:target});
  expect(readFileSync(path.join(target,'SKILL.md'),'utf8')).toBe('original');
  const restarted=new CompanyResources(f.store,f.root).shareService({kind:'skill',resolveDir:()=>f.source});
  expect(await restarted.sharedIds(scope)).toEqual(['skill-a']);
  expect(await f.service.share('skill-a',scope)).toEqual({version:2});
  await expect(f.service.unshare('skill-a',f.scope(f.viewer,f.team.id))).rejects.toThrow();
  expect(await f.service.unshare('skill-a',scope)).toBe(true);
  expect(await restarted.sharedIds(scope)).toEqual([]);
});

it('does not trust forged publisher roles, cross-team source IDs or revoked membership',async()=>{
  const f=fixture();
  const forged={...f.scope(f.viewer,f.team.id),canShare:true,principal:{...f.scope(f.viewer,f.team.id).principal,role:'owner' as const}};
  await expect(f.service.share('skill-a',forged)).rejects.toThrow();
  await expect(f.service.share('skill-a',f.scope(f.other,f.otherTeam.id))).rejects.toThrow();
  const old=f.scope(f.viewer,f.team.id);f.store.teams.removeMember(f.team.id,f.viewer.id,f.owner);
  await expect(f.service.sharedResources(old)).rejects.toThrow();
});

it('resolves a queued actor’s own catalogue permissions instead of a previous creator’s member selector',()=>{
  const f=fixture();
  insertProject(f.db,{id:'design',name:'Design',createdAt:1,updatedAt:1,metadata:{localCatalogScopes:{skill:{workspaceId:f.team.id,workspaceMemberId:f.owner.id}}}});
  f.store.teams.attach('design',f.team.id,f.owner);
  expect(f.resources.selectionContext(f.viewer,'design','skill')).toMatchObject({workspaceId:f.team.id,workspaceMemberId:f.viewer.id});
  f.store.teams.removeMember(f.team.id,f.viewer.id,f.owner);
  expect(()=>f.resources.selectionContext(f.viewer,'design','skill')).toThrow();
});
