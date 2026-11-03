import { expect, it } from 'vitest';
import type { Request, Response } from 'express';
import type { CompanyUser } from '@open-design/contracts';
import { createCompanyDiagnosticsAccess } from '../../src/company/http-policy.js';
import { requireLocalDaemonRequest } from '../../src/http/local-daemon-request.js';

function authorize(enabled: boolean, role: CompanyUser['role'] | null, local = false) {
  let status = 200, passed = false;
  const user = role ? { id:'actor', username:'actor', role, source:'local' as const, disabled:false, mustChangePassword:false } : null;
  const guard = createCompanyDiagnosticsAccess({enabled,getUser:()=>user},requireLocalDaemonRequest);
  const req = { method:'GET', get:(name:string)=>name==='host' ? local ? 'localhost:7456' : '172.27.1.18:7456' : undefined, socket:{remoteAddress:local ? '127.0.0.1' : '192.0.2.1'} } as Request;
  const res = {status(code:number) {status=code;return this;},setHeader() {return this;},json() {return this;}} as unknown as Response;
  guard(req,res,()=>{passed=true;});
  return {status,passed};
}

it('allows an authenticated company administrator to export diagnostics remotely',()=>{
  expect(authorize(true,'admin')).toEqual({status:200,passed:true});
});

it.each([['member',403],[null,401]] as const)('rejects company diagnostics for %s', (role,status)=>{
  expect(authorize(true,role)).toEqual({status,passed:false});
});

it('preserves the original local-only diagnostics boundary outside company mode',()=>{
  expect(authorize(false,'admin')).toEqual({status:403,passed:false});
  expect(authorize(false,null,true)).toEqual({status:200,passed:true});
});
