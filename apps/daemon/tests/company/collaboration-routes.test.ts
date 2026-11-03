import {afterEach,expect,it} from 'vitest';
import express from 'express';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {initializeCompany} from '../../src/company/routes.js';
import {companyTestDatabase} from './database.js';
import {CompanyResources} from '../../src/company/resources.js';
import {registerCompanyResourceRoutes} from '../../src/company/resource-routes.js';

const cleanups: Array<()=>unknown> = [];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse()) await cleanup();});
async function fixture() {
  const database=companyTestDatabase(),dataRoot=mkdtempSync(path.join(tmpdir(),'od-review-'));
  cleanups.push(()=>{database.close();rmSync(dataRoot,{recursive:true,force:true});});
  let busy=false;
  const runtime=await initializeCompany({database,dataRoot,projectIsBusy:()=>busy,
    config:{enabled:true,publicOrigin:'http://design.test',auth:{mode:'ldap'},teams:{enabled:true},presentation:{showAgentIdentity:false,hiddenSettingsSections:[]}},
    ldap:{authenticate:async()=>null,recheck:async()=>true},
  });
  const owner=runtime.store.upsertLdapUser({entryUUID:'owner',username:'owner'});
  const reviewer=runtime.store.upsertLdapUser({entryUUID:'reviewer',username:'reviewer'});
  const team=runtime.store.teams.create('Review',owner);
  runtime.store.teams.setMember(team.id,reviewer.id,'viewer',owner);
  runtime.store.teams.attach('team-design',team.id,owner);
  runtime.store.registerProjectOwner('personal',owner);
  const app=express();app.use(express.json());app.use(runtime.middleware);app.use(runtime.router);
  registerCompanyResourceRoutes(app,{company:runtime,resources:new CompanyResources(runtime.store,dataRoot)});
  app.all('/{*path}',(_req,res)=>res.json({ok:true}));
  const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanups.push(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const sessions={owner:runtime.auth.createSession(owner),reviewer:runtime.auth.createSession(reviewer)};
  const request=(actor:keyof typeof sessions,endpoint:string,body?:unknown)=>fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{
    cookie:`od_company_session=${sessions[actor].token}`,origin:'http://design.test','x-csrf-token':sessions[actor].csrfToken,'content-type':'application/json',
  },...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {runtime,team,owner,reviewer,request,setBusy:(value:boolean)=>{busy=value;}};
}

it('allows review mutations but keeps file edits, generation and archived review closed',async()=>{
  const f=await fixture(),comment='/api/projects/team-design/conversations/chat/comments';
  expect((await f.request('reviewer',comment,{note:'Please improve the title'})).status).toBe(200);
  expect((await f.request('reviewer','/api/projects/team-design/files/index.html',{content:'changed'})).status).toBe(403);
  expect((await f.request('reviewer','/api/runs',{projectId:'team-design'})).status).toBe(403);
  f.runtime.store.teams.update(f.team.id,{status:'archived'},f.owner);
  expect((await f.request('reviewer',comment,{note:'No archive mutations'})).status).toBe(403);
});

it('reports separate comment and generation capabilities from the same membership endpoint',async()=>{
  const f=await fixture();
  const body=await(await f.request('reviewer','/api/company/projects/team-design/members')).json();
  expect(body).toMatchObject({canWrite:false,canComment:true,ownerUserId:f.owner.id});
});

it('scopes original resource APIs to authenticated membership and refuses forged selectors or host paths',async()=>{
  const f=await fixture();
  const context=await(await f.request('reviewer','/api/company/resources/context?projectId=team-design')).json() as {context:unknown};
  expect(context.context).toMatchObject({workspaceId:f.team.id,workspaceMemberId:f.reviewer.id,permissions:{canShareProjects:false,canWriteSyncedFiles:false}});
  expect((await f.request('reviewer',`/api/skills?workspaceId=${f.team.id}&workspaceMemberId=${f.owner.id}`)).status).toBe(403);
  expect((await f.request('reviewer',`/api/skills/install?workspaceId=${f.team.id}`,{source:'https://example.test/skill'})).status).toBe(403);
  expect((await f.request('owner',`/api/skills/install?workspaceId=${f.team.id}`,{source:'/etc/shadow'})).status).toBe(403);
  expect((await f.request('owner',`/api/skills/install?workspaceId=${f.team.id}`,{source:'https://example.test/skill'})).status).toBe(200);
});

it('rejects transfers while queued or running and keeps ownership intact until the task is stopped',async()=>{
  const f=await fixture(),endpoint='/api/company/projects/personal/move';
  f.setBusy(true);
  expect((await f.request('owner',endpoint,{companyTeamId:f.team.id})).status).toBe(409);
  expect(f.runtime.store.projectRole('personal',f.owner.id)).toBe('owner');
  f.setBusy(false);
  expect((await f.request('owner',endpoint,{companyTeamId:f.team.id})).status).toBe(200);
  expect(f.runtime.store.teams.projectTeamId('personal')).toBe(f.team.id);
  expect((await f.request('reviewer',endpoint,{companyTeamId:null})).status).toBe(403);
  expect((await f.request('owner',endpoint,{companyTeamId:null})).status).toBe(200);
  expect(f.runtime.store.projectRole('personal',f.owner.id)).toBe('owner');
});
