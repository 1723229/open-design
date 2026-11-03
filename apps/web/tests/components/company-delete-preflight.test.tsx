// @vitest-environment jsdom
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {CompanyProvider} from '../../src/company/CompanyProvider';
import {activeFileSharesBeforeDelete} from '../../src/components/project-actions/activeFileSharesBeforeDelete';
import {useBatchProjectShareCount} from '../../src/components/project-actions/useBatchProjectShareCount';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const history=(projectId:string)=>({projectId,bindingExists:false,hasEverShared:false,publications:[]});
it('uses the verified company session for HTML deletion without a cloud workspace',async()=>{
  const request=vi.fn(async()=>Response.json(history('project')));vi.stubGlobal('fetch',request);
  expect(await activeFileSharesBeforeDelete('project',['index.html'],null,true)).toBe(0);
  expect(request).toHaveBeenCalledOnce();
  request.mockResolvedValueOnce(new Response('',{status:403}));
  await expect(activeFileSharesBeforeDelete('project',['index.html'],null,true)).rejects.toThrow();
  await expect(activeFileSharesBeforeDelete('project',['index.html'],null)).rejects.toThrow();
});
it('reads every selected project before enabling a company batch delete',async()=>{
  const request=vi.fn(async(input:RequestInfo|URL)=>String(input)==='/api/company/session'
    ? Response.json({enabled:true,user:{id:'member',username:'member',role:'member',mustChangePassword:false},csrfToken:'csrf',presentation:{showAgentIdentity:false,hiddenSettingsSections:[]}})
    : Response.json(history(String(input).split('/')[3]!)));
  vi.stubGlobal('fetch',request);
  function Batch(){const result=useBatchProjectShareCount(['one','two'],null);return <output>{JSON.stringify(result)}</output>;}
  render(<CompanyProvider><Batch/></CompanyProvider>);
  await waitFor(()=>expect(JSON.parse(screen.getByRole('status').textContent!)).toMatchObject({count:0,pending:false,failed:false}));
  expect(request.mock.calls.filter(([url])=>String(url).endsWith('/share-state'))).toHaveLength(2);
});
