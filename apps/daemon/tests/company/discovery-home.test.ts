import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareCompanyDiscoveryHome } from '../../src/company/api-main.js';
const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test('provisions an offline discovery profile outside project runtime homes once',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'company-discovery-'));roots.push(root);
  const source=path.join(root,'profile');mkdirSync(source);writeFileSync(path.join(source,'package.json'),'{"name":"companion"}');
  const env=prepareCompanyDiscoveryHome(path.join(root,'data'),source);
  expect(env.HOME).toBe(path.join(root,'data','company-discovery-home'));
  const profile=path.join(env.DSH_HOME!,'profiles','open-design','package.json');
  expect(JSON.parse(readFileSync(profile,'utf8')).name).toBe('companion');
  writeFileSync(profile,'{"name":"retained"}');
  prepareCompanyDiscoveryHome(path.join(root,'data'),source);
  expect(JSON.parse(readFileSync(profile,'utf8')).name).toBe('retained');
});
