import type {Server} from 'node:http';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import JSZip from 'jszip';

let root:string,base:string,executor:Server,started:{server:Server;shutdown?:()=>Promise<void>|void};
let closeDatabase:()=>void;
const sessions=new Map<string,{cookie:string;csrf:string;id:string}>();
const password='Resource-test-password-42';

async function request(actor:string,endpoint:string,method='GET',body?:unknown,workspaceId?:string) {
  const session=sessions.get(actor);
  const response=await fetch(base+endpoint,{method,headers:{origin:'http://design.test','content-type':'application/json',
    ...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),
    ...(workspaceId?{'x-nexus-resource-workspace-id':workspaceId}:{}),
  },...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json() as Record<string,any>;
  return {status:response.status,data,response};
}

beforeAll(async()=>{
  root=await mkdtemp(path.join(tmpdir(),'od-company-resource-http-'));
  vi.stubEnv('OD_DATA_DIR',root);
  vi.stubEnv('OD_ALLOWED_ORIGINS','http://design.test');
  vi.stubEnv('OD_COMPANY_PROXY_URL','http://127.0.0.1:9');
  vi.stubEnv('OD_COMPANY_PROXY_CONTROL_SECRET','resource-http-test-control');
  executor=createServer((req,res)=>{res.writeHead(req.url==='/reset'?200:404,{'content-type':'application/json'});res.end('{}');});
  await new Promise<void>(resolve=>executor.listen(0,'127.0.0.1',resolve));
  vi.stubEnv('OD_COMPANY_EXECUTOR_URL',`http://127.0.0.1:${(executor.address() as {port:number}).port}`);
  vi.stubEnv('OD_COMPANY_EXECUTOR_SECRET','resource-http-test-executor');
  await writeFile(path.join(root,'company.yaml'),`authentication:\n  enabled: true\n  default_provider: local\nserver:\n  public_origin: http://design.test\nteams:\n  enabled: true\n`);
  const dbModule=await import('../../src/db.js');closeDatabase=dbModule.closeDatabase;
  const {CompanyStore}=await import('../../src/company/store.js');
  const store=new CompanyStore(dbModule.openDatabase(process.cwd(),{dataDir:root}));
  const admin=store.createAdmin(password);store.changePassword(admin.id,password);
  for(const username of ['owner','reviewer','outsider']) {
    const user=store.createLocalUser(username,password,'member',admin.id);store.changePassword(user.id,password);
  }
  const {startServer}=await import('../../src/server.js');
  const server=await startServer({port:0,host:'127.0.0.1',returnServer:true}) as typeof started & {url:string};
  started=server;base=server.url;
  for(const username of ['admin','owner','reviewer','outsider']) {
    const {status,data,response}=await request(username,'/api/company/auth/login','POST',{username,password});
    expect(status,JSON.stringify(data)).toBe(200);
    sessions.set(username,{cookie:response.headers.get('set-cookie')!.split(';')[0]!,csrf:data.csrfToken,id:data.user.id});
  }
},60_000);

it('retains the native template/plugin upload and team-share interaction with scoped ownership',async()=>{
  const created=await request('owner','/api/company/teams','POST',{name:'Template library'});
  const teamId=created.data.team.id as string;
  await request('owner',`/api/company/teams/${teamId}/members`,'PUT',{userId:sessions.get('reviewer')!.id,role:'viewer'});
  const manifest=JSON.parse(await readFile(path.resolve('../../plugins/_official/examples/design-brief/open-design.json'),'utf8'));
  manifest.name='company-template-http';manifest.title='Company review template';
  const zip=new JSZip();zip.file('open-design.json',JSON.stringify(manifest));zip.file('SKILL.md','# Company template\nBuild a review page.');
  const form=new FormData();form.append('file',new Blob([await zip.generateAsync({type:'uint8array'})]),'company-template.zip');
  const session=sessions.get('owner')!;
  const response=await fetch(base+'/api/plugins/upload-zip',{method:'POST',headers:{origin:'http://design.test',cookie:session.cookie,'x-csrf-token':session.csrf,'x-nexus-resource-workspace-id':teamId},body:form});
  const uploaded=await response.json() as Record<string,any>;
  expect(response.status,JSON.stringify(uploaded)).toBe(200);
  expect(uploaded.ok,JSON.stringify(uploaded)).toBe(true);
  const id=uploaded.plugin.id as string;
  const detail=await request('owner',`/api/plugins/${encodeURIComponent(id)}`,'GET',undefined,teamId);
  expect(detail.status,JSON.stringify(detail.data)).toBe(200);
  const privateApply=await request('reviewer',`/api/plugins/${encodeURIComponent(id)}/apply-local`,'POST',{source:detail.data.source,inputs:{brief:'Review a page'}},teamId);
  expect(privateApply.status,JSON.stringify(privateApply.data)).toBe(404);
  const ownApply=await request('owner',`/api/plugins/${encodeURIComponent(id)}/apply-local`,'POST',{source:detail.data.source,inputs:{brief:'Review a page'}},teamId);
  expect(ownApply.status,JSON.stringify(ownApply.data)).toBe(200);
  const forged=await request('outsider','/api/projects','POST',{id:'forged-private-template',name:'Forbidden template',pluginId:id,pluginSource:detail.data.source,pluginInputs:{brief:'Review a page'}});
  expect(forged.status,JSON.stringify(forged.data)).toBe(404);
  const own=await request('owner','/api/projects','POST',{id:'own-template-project',name:'From template',companyTeamId:teamId,pluginId:id,pluginSource:detail.data.source,pluginInputs:{brief:'Review a page'},grantCaps:['fs:write','pipeline:*','prompt:inject']},teamId);
  expect(own.status,JSON.stringify(own.data)).toBe(200);
  const nativeProject=await request('owner','/api/projects/own-template-project');
  expect(nativeProject.status,JSON.stringify(nativeProject.data)).toBe(200);
  expect(nativeProject.data.project.companyTeamId).toBe(teamId);
  expect((await request('reviewer',`/api/plugins/${encodeURIComponent(id)}`,'GET',undefined,teamId)).status).toBe(404);
  const shared=await request('owner',`/api/workspace/plugins/${encodeURIComponent(id)}/share`,'POST',{},teamId);
  expect(shared.status,JSON.stringify(shared.data)).toBe(200);
  const listing=await request('reviewer','/api/workspace/plugins/team','GET',undefined,teamId);
  expect(listing.status,JSON.stringify(listing.data)).toBe(200);
  expect(listing.data.ids).toContain(id);
  const peer=await request('reviewer',`/api/plugins/${encodeURIComponent(id)}`,'GET',undefined,teamId);
  expect(peer.status,JSON.stringify(peer.data)).toBe(200);
  expect(peer.data.title).toBe('Company review template');
  const peerApply=await request('reviewer',`/api/plugins/${encodeURIComponent(id)}/apply-local`,'POST',{source:peer.data.source,inputs:{brief:'Review a page'}},teamId);
  expect(peerApply.status,JSON.stringify(peerApply.data)).toBe(200);
  const unshared=await request('owner',`/api/workspace/plugins/${encodeURIComponent(id)}/share`,'DELETE',undefined,teamId);
  expect(unshared.status,JSON.stringify(unshared.data)).toBe(200);
  expect((await request('reviewer',`/api/plugins/${encodeURIComponent(id)}`,'GET',undefined,teamId)).status).toBe(404);
},60_000);

it('rejects invalid upload paths as client errors without writing files',async()=>{
  const created=await request('owner','/api/projects','POST',{id:'invalid-upload-paths',name:'Upload boundary'});
  expect(created.status).toBe(200);
  for(const name of ['../company.yaml','/etc/passwd','nested/../../escape.txt','C:\\escape.txt']) {
    const uploaded=await request('owner','/api/projects/invalid-upload-paths/files','POST',{name,content:'must not be written'});
    expect(uploaded.status,JSON.stringify(uploaded.data)).toBe(400);
    expect(uploaded.data.error.code).toBe('BAD_REQUEST');
  }
  const listed=await request('owner','/api/projects/invalid-upload-paths/files');
  expect(listed.data.files).toEqual([]);
});

it('reuses saved project templates while enforcing source-project access on every read and create',async()=>{
  const source='qa-saved-template-source';
  expect((await request('owner','/api/projects','POST',{id:source,name:'Template source'})).status).toBe(200);
  expect((await request('owner',`/api/projects/${source}/files`,'POST',{name:'index.html',content:'<!doctype html><h1>Private template</h1>'})).status).toBe(200);
  const saved=await request('owner','/api/templates','POST',{name:'Private saved template',sourceProjectId:source});
  expect(saved.status,JSON.stringify(saved.data)).toBe(200);
  const id=saved.data.template.id as string;
  const list=await request('owner','/api/templates');
  expect(list.data.templates.some((item:{id:string})=>item.id===id)).toBe(true);
  expect((await request('outsider','/api/templates')).data.templates.some((item:{id:string})=>item.id===id)).toBe(false);
  expect((await request('outsider',`/api/templates/${id}`)).status).toBe(403);
  expect((await request('outsider','/api/templates','POST',{name:'Stolen',sourceProjectId:source})).status).toBe(403);
  expect((await request('outsider','/api/projects','POST',{id:'stolen-template',name:'Stolen',metadata:{kind:'template',templateId:id}})).status).toBe(403);
  await request('owner',`/api/company/projects/${source}/members`,'PUT',{userId:sessions.get('reviewer')!.id,role:'viewer'});
  const readable=await request('reviewer','/api/templates');
  expect(readable.data.templates.find((item:{id:string})=>item.id===id).canDelete).toBe(false);
  expect((await request('reviewer',`/api/templates/${id}`)).status).toBe(200);
  expect((await request('reviewer',`/api/templates/${id}`,'DELETE')).status).toBe(403);
  expect((await request('reviewer','/api/templates','POST',{name:'Private saved template',sourceProjectId:source,description:'Changed by viewer'})).status).toBe(403);
  expect((await request('owner',`/api/templates/${id}`)).data.template.description).not.toBe('Changed by viewer');
  const copy=await request('reviewer','/api/projects','POST',{id:'own-template-copy',name:'Template copy',metadata:{kind:'template',templateId:id}});
  expect(copy.status,JSON.stringify(copy.data)).toBe(200);
  const files=await request('reviewer','/api/projects/own-template-copy/files');
  expect(files.data.files.some((file:{name:string})=>file.name==='index.html')).toBe(true);
  await request('owner',`/api/company/projects/${source}/members/${sessions.get('reviewer')!.id}`,'DELETE');
  expect((await request('reviewer',`/api/templates/${id}`)).status).toBe(403);
  expect((await request('owner',`/api/templates/${id}`,'DELETE')).status).toBe(200);
},30_000);

it('preserves original project metadata when members auto-name a new project without allowing protected changes',async()=>{
  const created=await request('owner','/api/projects','POST',{id:'qa-auto-name-project',name:'Prototype',metadata:{kind:'prototype',nameSource:'generated',platformTargets:['responsive'],fidelity:'high-fidelity'}});
  expect(created.status,JSON.stringify(created.data)).toBe(200);
  const original=(await request('owner','/api/projects/qa-auto-name-project')).data.project;
  for(const nameSource of ['prompt','agent']) {
    const renamed=await request('owner','/api/projects/qa-auto-name-project','PATCH',{name:`Title from ${nameSource}`,metadata:{...original.metadata,nameSource}});
    expect(renamed.status,JSON.stringify(renamed.data)).toBe(200);
    expect(renamed.data.project.metadata).toEqual({...original.metadata,nameSource});
  }
  for(const extra of [{baseDir:'/host-private'},{platformTargets:['desktop']},{localCatalogScopes:{designSystem:{workspaceId:'foreign'}}},{strategyBinding:{taskProfile:'foreign'}}]) {
    expect((await request('owner','/api/projects/qa-auto-name-project','PATCH',{metadata:{...original.metadata,...extra}})).status).toBe(403);
  }
  await request('owner','/api/company/projects/qa-auto-name-project/members','PUT',{userId:sessions.get('reviewer')!.id,role:'viewer'});
  expect((await request('reviewer','/api/projects/qa-auto-name-project','PATCH',{name:'Viewer rename',metadata:{...original.metadata,nameSource:'agent'}})).status).toBe(403);
});

it('provides authorized local share history for the original delete confirmations',async()=>{
  const created=await request('owner','/api/projects','POST',{id:'company-delete-history',name:'Delete history'});
  expect(created.status).toBe(200);
  const history=await request('owner','/api/projects/company-delete-history/share-state');
  expect(history.status,JSON.stringify(history.data)).toBe(200);
  expect(history.data).toEqual({projectId:'company-delete-history',bindingExists:false,hasEverShared:false,publications:[]});
  const {openDatabase}=await import('../../src/db.js');
  openDatabase(process.cwd(),{dataDir:root}).prepare(`INSERT INTO public_file_publications
    (resource_team_id,owner_member_id,project_id,file_path,slug,file_name,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run('legacy-team','legacy-owner','company-delete-history','index.html','retained-link','index.html',1,1);
  const retained=await request('owner','/api/projects/company-delete-history/share-state');
  expect(retained.data.publications).toEqual([{sourceFilePath:'index.html',slug:'retained-link',status:'active'}]);
  expect(retained.data.hasEverShared).toBe(true);
  expect((await request('outsider','/api/projects/company-delete-history/share-state')).status).toBe(403);
  await request('owner','/api/company/projects/company-delete-history/members','PUT',{userId:sessions.get('reviewer')!.id,role:'viewer'});
  expect((await request('reviewer','/api/projects/company-delete-history/share-state')).status).toBe(200);
  expect((await request('reviewer','/api/projects/company-delete-history','DELETE')).status).toBe(403);
});

afterAll(async()=>{
  await started?.shutdown?.();
  if(started?.server.listening) await new Promise<void>(resolve=>{started.server.close(()=>resolve());started.server.closeAllConnections();});
  if(executor?.listening) await new Promise<void>(resolve=>{executor.close(()=>resolve());executor.closeAllConnections();});
  closeDatabase?.();vi.unstubAllEnvs();
  if(root) await rm(root,{recursive:true,force:true});
});

it('creates from the original DESIGN.md form with an owned brand project and isolates brand endpoints',async()=>{
  const created=await request('owner','/api/brands','POST',{designMd:'# QA brand\n\n## Colors\nPrimary: #17202a\n\n## Typography\nArial, sans-serif'});
  expect(created.status,JSON.stringify(created.data)).toBe(200);
  const {id,projectId,designSystemId}=created.data;
  expect(typeof projectId).toBe('string');
  const project=await request('owner',`/api/projects/${projectId}`);
  expect(project.status).toBe(200);
  expect(project.data.project.workspaceId).toBeNull();
  expect((await request('owner',`/api/design-systems/${encodeURIComponent(designSystemId)}`)).status).toBe(200);
  const listing=await request('owner','/api/brands');
  expect(listing.data.brands.some((item:{meta:{id:string}})=>item.meta.id===id)).toBe(true);
  const other=await request('outsider','/api/brands');
  expect(other.data.brands.some((item:{meta:{id:string}})=>item.meta.id===id)).toBe(false);
  for(const [method,suffix] of [['GET',''],['POST','/cancel-extraction'],['DELETE','']]) {
    expect((await request('outsider',`/api/brands/${id}${suffix}`,method,method==='POST'?{}:undefined)).status).toBe(403);
  }
  expect((await request('owner',`/api/brands/${id}/preview`,'POST',{projectId:'unrelated-project'})).status).toBe(403);
  expect((await request('owner',`/api/brands/${id}/cancel-extraction`,'POST',{})).status).toBe(200);
  const removed=await request('owner',`/api/brands/${id}`,'DELETE');
  expect([200,409],JSON.stringify(removed.data)).toContain(removed.status);
  if(removed.status===409) expect(removed.data.error).toBe('BRAND_EXTRACTION_STILL_STOPPING');
},60_000);

it('binds original brand extraction to the selected team and rejects read-only or foreign scopes',async()=>{
  const team=(await request('owner','/api/company/teams','POST',{name:'Brand extraction team'})).data.team;
  await request('owner',`/api/company/teams/${team.id}/members`,'PUT',{userId:sessions.get('reviewer')!.id,role:'viewer'});
  const input={designMd:'# Team brand\nPrimary: #123456'};
  expect((await request('reviewer','/api/brands','POST',input,team.id)).status).toBe(403);
  expect((await request('outsider','/api/brands','POST',input,team.id)).status).toBe(403);
  const created=await request('owner','/api/brands','POST',input,team.id);
  expect(created.status,JSON.stringify(created.data)).toBe(200);
  const project=await request('reviewer',`/api/projects/${created.data.projectId}`);
  expect(project.status,JSON.stringify(project.data)).toBe(200);
  expect(project.data.project.workspaceId).toBeNull();
  expect(project.data.project.companyAccess.canWrite).toBe(false);
  expect((await request('reviewer',`/api/brands/${created.data.id}`)).status).toBe(200);
  expect((await request('reviewer',`/api/brands/${created.data.id}/cancel-extraction`,'POST',{},team.id)).status).toBe(403);
  await request('owner',`/api/brands/${created.data.id}/cancel-extraction`,'POST',{},team.id);
},60_000);

it('uses the original resource APIs to publish, materialize, read and revoke a team skill',async()=>{
  const created=await request('owner','/api/company/teams','POST',{name:'Shared library'});
  expect(created.status,JSON.stringify(created.data)).toBe(201);
  const teamId=created.data.team.id as string;
  const member=await request('owner',`/api/company/teams/${teamId}/members`,'PUT',{userId:sessions.get('reviewer')!.id,role:'viewer'});
  expect(member.status,JSON.stringify(member.data)).toBe(200);
  const imported=await request('owner','/api/skills/import','POST',{name:'company-review-http',description:'Shared review',body:'Always check contrast.'},teamId);
  expect(imported.status,JSON.stringify(imported.data)).toBe(201);
  const skillId=imported.data.skill.id as string;
  const peerPrivate=await request('reviewer',`/api/skills/${encodeURIComponent(skillId)}`,'GET',undefined,teamId);
  expect(peerPrivate.status).toBe(404);
  const shared=await request('owner',`/api/workspace/skills/${encodeURIComponent(skillId)}/share`,'POST',{},teamId);
  expect(shared.status,JSON.stringify(shared.data)).toBe(200);
  expect(shared.data).toMatchObject({shared:true,version:1});
  const listing=await request('reviewer','/api/workspace/skills/team','GET',undefined,teamId);
  expect(listing.status,JSON.stringify(listing.data)).toBe(200);
  expect(listing.data.ids).toContain(skillId);
  const detail=await request('reviewer',`/api/skills/${encodeURIComponent(skillId)}`,'GET',undefined,teamId);
  expect(detail.status,JSON.stringify(detail.data)).toBe(200);
  expect(JSON.stringify(detail.data)).toContain('Always check contrast.');
  await request('owner',`/api/company/teams/${teamId}/members`,'PUT',{userId:sessions.get('reviewer')!.id,role:'editor'});
  const fromSkill=await request('reviewer','/api/projects','POST',{id:'shared-skill-project',name:'Using shared skill',companyTeamId:teamId,skillId},teamId);
  expect(fromSkill.status,JSON.stringify(fromSkill.data)).toBe(200);
  const scoped=await request('reviewer','/api/company/resources/context?projectId=shared-skill-project');
  expect(scoped.data.context.workspaceMemberId).toBe(sessions.get('reviewer')!.id);
  await request('owner',`/api/company/teams/${teamId}/members`,'PUT',{userId:sessions.get('reviewer')!.id,role:'viewer'});
  const context=await request('reviewer',`/api/company/resources/context?kind=skill&resourceId=${encodeURIComponent(skillId)}`);
  expect(context.status,JSON.stringify(context.data)).toBe(200);
  expect(context.data.context).toMatchObject({workspaceId:teamId,workspaceMemberId:sessions.get('reviewer')!.id});
  expect((await request('outsider','/api/workspace/skills/team','GET',undefined,teamId)).status).toBe(403);
  expect((await request('reviewer',`/api/skills/${encodeURIComponent(skillId)}`,'PUT',{name:'forged',body:'changed'},teamId)).status).toBe(403);
  const unshared=await request('owner',`/api/workspace/skills/${encodeURIComponent(skillId)}/share`,'DELETE',undefined,teamId);
  expect(unshared.status,JSON.stringify(unshared.data)).toBe(200);
  const removed=await request('reviewer','/api/workspace/skills/team','GET',undefined,teamId);
  expect(removed.data.ids).not.toContain(skillId);
  expect((await request('reviewer',`/api/skills/${encodeURIComponent(skillId)}`,'GET',undefined,teamId)).status).toBe(404);
},60_000);

it('keeps the original design-system authoring project accessible and shares its published snapshot',async()=>{
  const created=await request('owner','/api/company/teams','POST',{name:'Design library'});
  const teamId=created.data.team.id as string;
  await request('owner',`/api/company/teams/${teamId}/members`,'PUT',{userId:sessions.get('reviewer')!.id,role:'viewer'});
  const design=await request('owner','/api/design-systems','POST',{title:'Company HTTP design system',artifactMode:'agent-managed',body:'# Design rules\nUse a clear type hierarchy.'},teamId);
  expect(design.status,JSON.stringify(design.data)).toBe(201);
  const id=design.data.designSystem.id as string;
  const workspace=await request('owner',`/api/design-systems/${encodeURIComponent(id)}/workspace`,'POST',{},teamId);
  expect(workspace.status,JSON.stringify(workspace.data)).toBe(201);
  const project=await request('owner',`/api/projects/${workspace.data.project.id}`);
  expect(project.status,JSON.stringify(project.data)).toBe(200);
  expect(project.data.project.companyAccess.canWrite).toBe(true);
  const editorContext=await request('owner',`/api/company/resources/context?projectId=${workspace.data.project.id}`);
  expect(editorContext.data.context.workspaceId).toBe(teamId);
  const shared=await request('owner',`/api/workspace/design-systems/${encodeURIComponent(id)}/share`,'POST',{},teamId);
  expect(shared.status,JSON.stringify(shared.data)).toBe(200);
  const listing=await request('reviewer','/api/workspace/design-systems/team','GET',undefined,teamId);
  expect(listing.status,JSON.stringify(listing.data)).toBe(200);
  expect(listing.data.ids).toContain(id);
  const detail=await request('reviewer',`/api/design-systems/${encodeURIComponent(id)}`,'GET',undefined,teamId);
  expect(detail.status,JSON.stringify(detail.data)).toBe(200);
  expect(JSON.stringify(detail.data)).toContain('Use a clear type hierarchy.');
  expect((await request('reviewer',`/api/design-systems/${encodeURIComponent(id)}/workspace`,'POST',{},teamId)).status).toBe(403);
  expect((await request('outsider',`/api/projects/${workspace.data.project.id}`)).status).toBe(403);
},60_000);

it('exposes only authenticated task capacity through the original company session',async()=>{
  const status=await request('owner','/api/company/tasks');
  expect(status.status,JSON.stringify(status.data)).toBe(200);
  expect(status.data).toEqual({limits:{global:12,perUser:3,perProject:1},usage:{globalRunning:0,userRunning:0,userQueued:0},tasks:[]});
  expect((await request('anonymous','/api/company/tasks')).status).toBe(401);
});

it('lets members load the original plugin marketplace catalogue while administration stays restricted',async()=>{
  const catalog=await request('owner','/api/marketplaces');
  expect(catalog.status,JSON.stringify(catalog.data)).toBe(200);
  expect(catalog.data.marketplaces.some((entry:{manifest:{plugins?:unknown[]}})=>entry.manifest.plugins?.length)).toBe(true);
  expect((await request('owner','/api/marketplaces','POST',{url:'https://example.test/plugins'})).status).toBe(403);
  expect((await request('owner','/api/marketplaces/official','DELETE',{})).status).toBe(403);
});

it('lets members try an exact visible bundled plugin without allowing server filesystem imports',async()=>{
  const id='example-huashu-pentagram-grid';
  const plugin=await request('owner',`/api/plugins/${id}`);
  expect(plugin.status,JSON.stringify(plugin.data)).toBe(200);
  const applied=await request('owner',`/api/plugins/${id}/apply-local`,'POST',{source:plugin.data.source,inputs:{},grantCaps:[],locale:'zh-CN'});
  expect(applied.status,JSON.stringify(applied.data)).toBe(200);
  expect(applied.data.ok).toBe(true);
  expect((await request('owner',`/api/plugins/${id}/apply-local`,'POST',{source:plugin.data.source+'/../private',inputs:{}})).status).toBe(404);
  expect((await request('owner','/api/plugins/install','POST',{source:plugin.data.source})).status).toBe(403);
});

it('keeps global MCP credentials administrator-only and preserves the original configuration save API',async()=>{
  const original=await request('admin','/api/mcp/servers');
  expect(original.status,JSON.stringify(original.data)).toBe(200);
  expect(original.data.templates.length).toBeGreaterThan(0);
  try {
    const servers=[{id:'company-mcp-test',transport:'http',authMode:'none',url:'https://mcp.test/tools',enabled:false,headers:{Authorization:'Bearer mcp-test-secret'}}];
    const saved=await request('admin','/api/mcp/servers','PUT',{servers});
    expect(saved.status,JSON.stringify(saved.data)).toBe(200);
    expect((await request('admin','/api/mcp/servers')).data.servers).toEqual(servers);
    const denied=await request('owner','/api/mcp/servers');
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.data)).not.toContain('mcp-test-secret');
    expect((await request('owner','/api/mcp/servers','PUT',{servers:[]})).status).toBe(403);
    expect((await request('anonymous','/api/mcp/servers')).status).toBe(401);
  } finally {
    expect((await request('admin','/api/mcp/servers','PUT',{servers:original.data.servers})).status).toBe(200);
  }
});
