// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {I18nProvider} from '../../src/i18n';
import {useCompanyProjectMove} from '../../src/company/CompanyProjectMove';
import type {Project} from '../../src/types';

vi.mock('../../src/company/CompanyProvider',async original=>({...await original<typeof import('../../src/company/CompanyProvider')>(),useCompany:()=>({enabled:true,teamsEnabled:true,user:{id:'owner',username:'owner',role:'member'}})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const project={id:'design',name:'Design',companyTeamId:null,companyAccess:{canManage:true,canWrite:true,canComment:true,ownerUserId:'owner'}} as Project;
function Host({onMoved}:{onMoved:()=>void}) {
  const move=useCompanyProjectMove(onMoved);
  return <><button onClick={()=>move.request(project)}>Move</button>{move.dialog}</>;
}
it('chooses a verified writable team in the original confirmation and posts only after confirmation',async()=>{
  const posted:unknown[]=[],onMoved=vi.fn();
  vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
    if(init?.method==='POST') {posted.push(JSON.parse(String(init.body)));return Response.json({projectId:'design',companyTeamId:'b'});}
    return Response.json({teams:[{id:'a',name:'Team A',canWrite:true},{id:'b',name:'Team B',canWrite:true},{id:'c',name:'Read only',canWrite:false}]});
  }));
  render(<I18nProvider initial="en"><Host onMoved={onMoved}/></I18nProvider>);fireEvent.click(screen.getByText('Move'));
  const select=await screen.findByRole('combobox');
  await screen.findByRole('option',{name:'Team B'});
  expect(screen.queryByRole('option',{name:'Read only'})).toBeNull();
  expect(posted).toEqual([]);
  fireEvent.change(select,{target:{value:'b'}});
  fireEvent.click(screen.getByRole('button',{name:'Confirm move'}));
  await waitFor(()=>expect(onMoved).toHaveBeenCalledTimes(1));
  expect(posted).toEqual([{companyTeamId:'b'}]);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});
it('retains the confirmation and error when the server refuses a busy project',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'
    ? Response.json({error:'Stop the running task first'},{status:409}) : Response.json({teams:[{id:'a',name:'Team A',canWrite:true}]})));
  render(<I18nProvider initial="en"><Host onMoved={()=>{throw new Error('Rejected move must not refresh');}}/></I18nProvider>);
  fireEvent.click(screen.getByText('Move'));await screen.findByRole('option',{name:'Team A'});
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'a'}});
  fireEvent.click(screen.getByRole('button',{name:'Confirm move'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Stop the running task first');
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});
