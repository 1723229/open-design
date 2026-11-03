// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {CompanyResourceProvider,useResourceWorkspaceContext} from '../../src/company/CompanyResourceContext';
import {navigate} from '../../src/router';

vi.mock('../../src/company/CompanyProvider',async original=>({...await original<typeof import('../../src/company/CompanyProvider')>(),useCompany:()=>({enabled:true,user:{id:'user',username:'User',role:'member'}})}));
vi.mock('../../src/collab/useWorkspaceContext',()=>({useWorkspaceContext:()=>({context:null,loading:false})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function Probe(){const state=useResourceWorkspaceContext();return <output>{state.loading?'loading':state.context?.workspaceId ?? 'unavailable'}</output>;}
it('does not render a previous team resource context while the replacement is loading or after a late reply',async()=>{
  const pending=new Map<string,(response:Response)=>void>();
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>new Promise<Response>(resolve=>pending.set(String(input),resolve))));
  await act(async()=>navigate({kind:'home',view:'design-systems',companyTeamId:'a'}));
  render(<CompanyResourceProvider><Probe/></CompanyResourceProvider>);
  await waitFor(()=>expect(pending.has('/api/company/resources/context?teamId=a')).toBe(true));
  await act(async()=>navigate({kind:'home',view:'design-systems',companyTeamId:'b'}));
  expect(screen.getByText('loading')).toBeTruthy();
  await waitFor(()=>expect(pending.has('/api/company/resources/context?teamId=b')).toBe(true));
  await act(async()=>pending.get('/api/company/resources/context?teamId=b')!(Response.json({context:{identitySource:'company',workspaceId:'b',workspaceMemberId:'user',workspaceType:'team',role:'member',memberStatus:'active',lifecycleState:'active',permissions:{canShareProjects:true,canWriteSyncedFiles:true}}})));
  expect(screen.getByText('b')).toBeTruthy();
  await act(async()=>pending.get('/api/company/resources/context?teamId=a')!(Response.json({context:{workspaceId:'a'}})));
  expect(screen.queryByText('a')).toBeNull();
  expect(screen.getByText('b')).toBeTruthy();
});
