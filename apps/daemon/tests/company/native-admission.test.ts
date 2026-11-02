import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CompanyModelSettings, COMPANY_MODEL_AGENTS } from '../../src/company/model-settings.js';
test('native evidence is Agent-specific and failure preserves the active route', async () => {
 const root=mkdtempSync(path.join(tmpdir(),'admission-'));
 try {
  let success=true;
  const s=new CompanyModelSettings(root,{nativeProbe:async r=>({model:r.model,protocol:r.protocol,status:success?'supported':'error',checkedAt:Date.now(),...(r.agentId ? {testedBy:r.agentId} : {}),verification:'file-write'}),fetchImpl:async()=>new Response('',{status:400})});
  let v=s.saveProvider({expectedRevision:0,name:'Relay',baseUrl:'https://relay.test',apiKey:'secret',models:['m']});
  const providerId=v.providers[0]!.id; const agents=COMPANY_MODEL_AGENTS.map(a=>({...a,installed:true}));
  const route={providerId,model:'m',agentId:'codex' as const,protocol:'responses' as const};
  v=await s.testProvider({...route,expectedRevision:v.revision});
  expect(v.providers[0]!.capabilities).toContainEqual(expect.objectContaining({testedBy:'codex',verification:'file-write',status:'supported'}));
  v=s.activate({...route,expectedRevision:v.revision},agents); const pinned=s.pinActive();
  v=await s.testProvider({...route,agentId:'opencode',expectedRevision:v.revision});
  expect(v.providers[0]!.capabilities.filter(c=>c.verification==='file-write')).toHaveLength(2);
  success=false; v=await s.testProvider({...route,expectedRevision:v.revision});
  expect(()=>s.activate({...route,expectedRevision:v.revision},agents)).toThrow();
  expect(s.pinActive()).toEqual(pinned);
  expect(v.providers[0]!.capabilities.some(c=>c.testedBy==='opencode'&&c.status==='supported')).toBe(true);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('legacy active routes survive restart but legacy and generic evidence cannot authorize a new activation', async () => {
 const root=mkdtempSync(path.join(tmpdir(),'admission-'));
 try {
  const legacy={agentId:'codex',agentModels:{codex:{model:'m'}},agentCliEnv:{codex:{OPENAI_API_KEY:'secret'}}};
  const s=new CompanyModelSettings(root,{legacy,fetchImpl:async()=>new Response('data: {"type":"response.output_item.done","item":{"type":"function_call","name":"nexus_probe","arguments":"{}"}}\n\ndata: {"type":"response.completed"}\n\n',{headers:{'content-type':'text/event-stream'}})});
  const pinned=s.pinActive();const agents=COMPANY_MODEL_AGENTS.map(a=>({...a,installed:true}));
  const v=await s.testProvider({expectedRevision:s.view().revision,providerId:pinned.providerId,model:'m'});
  expect(v.providers[0]!.capabilities.some(c=>c.status==='supported')).toBe(true);
  expect(()=>s.activate({...pinned,expectedRevision:v.revision},agents)).toThrow();
  expect(new CompanyModelSettings(root).pinActive()).toEqual(pinned);
 } finally {rmSync(root,{recursive:true,force:true});}
});
