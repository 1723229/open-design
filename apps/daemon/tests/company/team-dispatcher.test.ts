import { expect, it } from 'vitest';
import { CompanyStore } from '../../src/company/store.js';
import { CompanyJobQueue, type QueueDatabase } from '../../src/company/job-queue.js';
import { CompanyDispatcher } from '../../src/company/dispatcher.js';
import { companyTestDatabase } from './database.js';

it.each(['downgrade','remove','archive','expiry'] as const)('cancels running and queued team jobs after %s without starting another task',async change=>{
  const db=companyTestDatabase();let now=1_000_000;
  try {
    const store=new CompanyStore(db,()=>now);
    const owner=store.upsertLdapUser({entryUUID:'owner',username:'owner'}),editor=store.upsertLdapUser({entryUUID:'editor',username:'editor'});
    const team=change==='expiry'
      ? store.teams.sync('external','instance','business',{name:'External',status:'active',complete:true,members:[{entryUUID:'editor',username:'editor',role:'editor'}]},0)
      : store.teams.create('Native',owner);
    if(change!=='expiry')store.teams.setMember(team.id,editor.id,'editor',owner);
    const queue=new CompanyJobQueue(db as unknown as QueueDatabase,{global:1,perUser:1,perProject:1});
    let starts=0,cancellations=0,revocations=0;
    const dispatcher=new CompanyDispatcher({queue,authorize:job=>store.canAccess(store.getUser(job.userId),job.projectId,true),
      createLease:async()=>({agentId:'codex',model:'test-model'}),start:async()=>{starts++;return 'running';},terminalState:()=>null,
      cancel:async()=>{cancellations++;},revokeLease:async()=>{revocations++;}});
    const jobs=['one','two','three'].map(projectId=>{
      store.teams.attach(projectId,team.id,editor);
      return dispatcher.dispatch({userId:editor.id,projectId,clientRequestId:projectId,payload:{}}).job;
    });
    await dispatcher.pump();expect(starts).toBe(1);expect(jobs.filter(job=>queue.get(job.id)?.state==='queued')).toHaveLength(2);
    if(change==='downgrade')store.teams.setMember(team.id,editor.id,'viewer',owner);
    else if(change==='remove')store.teams.removeMember(team.id,editor.id,owner);
    else if(change==='archive')store.teams.update(team.id,{status:'archived'},owner);
    else now+=300_001;
    await dispatcher.pump();
    expect(jobs.map(job=>queue.get(job.id)?.state)).toEqual(['cancelled','cancelled','cancelled']);
    expect(starts).toBe(1);expect(cancellations).toBe(3);expect(revocations).toBe(3);
    expect(dispatcher.executionForProject('one')).toBeUndefined();
  } finally {db.close();}
});
