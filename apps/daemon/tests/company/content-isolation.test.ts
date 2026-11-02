import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { liveArtifactStorePaths } from '../../src/live-artifacts/store.js';
import { executeLocalDaemonRefreshSource } from '../../src/live-artifacts/refresh.js';
const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(path.join(tmpdir(),'company-content-'));roots.push(root);const projects=path.join(root,'projects');mkdirSync(path.join(projects,'p'),{recursive:true});return{root,projects};}
test('live artifact storage rejects a directory redirected outside its project',()=>{
  const {root,projects}=fixture();const outside=path.join(root,'outside');mkdirSync(outside);
  symlinkSync(outside,path.join(projects,'p','.live-artifacts'),'junction');
  expect(()=>liveArtifactStorePaths(projects,'p','la-test-123456abcdef')).toThrow(/escape/i);
});
test('company refresh policy rejects a host command source before execution',async()=>{
  const {projects}=fixture();
  await expect(executeLocalDaemonRefreshSource({projectsRoot:projects,projectId:'p',source:{type:'daemon_tool',toolName:'git.summary',input:{},refreshPermission:'manual_refresh_granted_for_read_only'},allowSource:()=>false})).rejects.toThrow(/not available/i);
});
