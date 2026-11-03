// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {I18nProvider} from '../../src/i18n';
import {CompanyTasksDialog} from '../../src/company/CompanyTasksDialog';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shows real queue capacity and links to the original project run controls',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({limits:{global:12,perUser:3,perProject:1},usage:{globalRunning:5,userRunning:1,userQueued:1},tasks:[
    {jobId:'a',projectId:'project-a',projectName:'My running design',runId:'run-a',state:'running',createdAt:1},
    {jobId:'b',projectId:'project-b',projectName:'My queued design',runId:'run-b',state:'queued',createdAt:2},
  ]})));
  render(<I18nProvider initial="en"><CompanyTasksDialog onClose={()=>{}}/></I18nProvider>);
  expect(await screen.findByText('1/3 running · 1 queued')).toBeTruthy();
  expect(screen.getByText('5/12 running across the platform')).toBeTruthy();
  expect(screen.getByRole('link',{name:'My queued design'})).toHaveAttribute('href','/projects/project-b');
  expect(screen.getByRole('img',{name:'Queued'})).toBeTruthy();
});
