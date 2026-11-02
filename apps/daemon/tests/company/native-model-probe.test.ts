import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, linkSync, symlinkSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompanyBridgeRequest } from '../../src/company/executor-client.js';
import type { CompanyModelLease } from '../../src/company/model-proxy.js';
import { createNativeCompanyModelProbe } from '../../src/company/native-model-probe.js';

const fixtures = vi.hoisted(() => ({relay:vi.fn(),stop:vi.fn(),register:vi.fn(),revoke:vi.fn()}));
vi.mock('../../src/company/executor-client.js', () => ({relayCompanyExecution:fixtures.relay,stopCompanyExecution:fixtures.stop}));
vi.mock('../../src/company/model-proxy.js', () => ({registerCompanyModelLease:fixtures.register,revokeCompanyModelLease:fixtures.revoke}));
let root: string; let execution: CompanyBridgeRequest; let lease: CompanyModelLease; let prompt: string; let fileNonce: string;
beforeEach(() => {
  vi.resetAllMocks(); root = mkdtempSync(path.join(tmpdir(),'native-探测-'));
  fixtures.register.mockImplementation(async (_origin, _secret, value) => { lease = value; });
  fixtures.stop.mockResolvedValue(undefined); fixtures.revoke.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); rmSync(root,{recursive:true,force:true}); });
const request = {agentId:'claude' as const,model:'native-model',protocol:'anthropic-messages' as const,baseUrl:'https://provider.test/v1',apiKey:'private-real-key',now:()=>123};
function probe(timeoutMs?: number) { return createNativeCompanyModelProbe({dataRoot:root,proxyUrl:'http://proxy',proxySecret:'proxy-control',executorUrl:'http://executor',executorSecret:'executor-control',...(timeoutMs ? {timeoutMs} : {})})(request); }
function fixture(kind = 'success') {
  fixtures.relay.mockImplementation(async (config, input, stdout) => {
    execution = config; prompt = ''; for await (const chunk of input) prompt += chunk;
    const file = path.join(config.execution.cwd,'nonce.txt'); expect(existsSync(file)).toBe(false); const nonce = /[a-f0-9]{64}/.exec(prompt)![0]; fileNonce=nonce;
    if (!['text-only','wrong-target','malformed'].includes(kind)) writeFileSync(file,kind==='wrong-nonce' ? 'wrong' : kind==='large-file' ? nonce.repeat(10000) : nonce);
    if (kind==='symlink') { rmSync(file); const other=path.join(config.execution.cwd,'source.txt'); writeFileSync(other,nonce); symlinkSync(other,file); }
    if (kind==='hardlink') linkSync(file,path.join(config.execution.cwd,'alias.txt'));
    if (kind==='wrong-target') writeFileSync(path.join(config.execution.cwd,'other.txt'),nonce);
    const tool = {type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'read-1',name:'Read',input:{file_path:kind==='wrong-target' ? '/other' : file}}]}};
    const terminal = {type:'result',subtype:kind==='failed' ? 'error_during_execution' : 'success',is_error:kind==='failed',result:kind==='wrong-nonce' ? 'unknown' : nonce};
    if (kind!=='text-only') stdout.write(JSON.stringify(kind==='malformed' ? {...tool,message:{content:'bad'}} : tool)+'\n');
    stdout.write(kind==='oversize' ? 'x'.repeat(1024*1024+1) : JSON.stringify(terminal)+(kind==='truncated' ? '' : '\n'));
    return kind==='exit-error' ? 1 : 0;
  });
}
function cleaned() {
  expect(fixtures.stop).toHaveBeenCalledTimes(1); expect(fixtures.revoke).toHaveBeenCalledTimes(1);
  expect(readdirSync(path.join(root,'projects'))).toEqual([]);
  expect(readdirSync(path.join(root,'agent-homes'))).toEqual([]);
  expect(fixtures.stop.mock.invocationCallOrder[0]).toBeLessThan(fixtures.revoke.mock.invocationCallOrder[0]!);
}
test('requires an actual new file and terminal success with scoped credentials and complete stdin', async () => {
  fixture(); const result = await probe();
  expect(result).toEqual({model:'native-model',protocol:'anthropic-messages',status:'supported',checkedAt:123,testedBy:'claude',verification:'file-write'});
  expect(lease).toMatchObject({apiKey:'private-real-key',wireProtocol:'anthropic-messages',protocol:'anthropic',agentId:'claude',model:'native-model'});
  expect(JSON.stringify(execution)).not.toContain('private-real-key');
  expect(execution.execution).toMatchObject({inputMode:'complete',agentId:'claude',model:'native-model',env:{},token:lease.token});
  expect(execution.execution.args).toEqual(['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--model','native-model','--permission-mode','bypassPermissions']);
  expect(JSON.parse(prompt).message.content[0].text).toContain('nonce.txt');
  expect(prompt).toContain(fileNonce); cleaned();
});
test.each(['text-only','malformed','wrong-target','wrong-nonce','failed','oversize','exit-error','large-file','hardlink','truncated','symlink'])('%s cannot establish native capability', async kind => {
  fixture(kind); const result = await probe(); expect(result.status).not.toBe('supported');
  expect(JSON.stringify(result)).not.toContain('private-real-key'); cleaned();
});
test('executor failure revokes and cleans owned resources', async () => {
  fixtures.relay.mockRejectedValue(new Error('private-real-key')); expect((await probe()).status).toBe('error'); cleaned();
});
test('deadline stops stalled execution before revoking lease and removing directories', async () => {
  vi.useFakeTimers(); fixtures.relay.mockImplementation(()=>new Promise(()=>{}));
  const result = probe(30_000); await vi.advanceTimersByTimeAsync(29_999); expect(fixtures.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect((await result).status).toBe('error'); cleaned();
});
test('failed lease registration still revokes a possibly accepted lease', async () => {
  fixtures.register.mockRejectedValue(new Error('network')); expect((await probe()).status).toBe('error');
  expect(fixtures.relay).not.toHaveBeenCalled(); cleaned();
});

test('explicit cancellation stops an in-flight native probe and revokes its lease', async () => {
  let started!: () => void; const ready = new Promise<void>(r=>{started=r;});
  fixtures.relay.mockImplementation(()=>{started();return new Promise(()=>{});});
  const controller = new AbortController();
  const result = createNativeCompanyModelProbe({dataRoot:root,proxyUrl:'http://proxy',proxySecret:'proxy-control',executorUrl:'http://executor',executorSecret:'executor-control'})({...request,signal:controller.signal});
  await ready; controller.abort(); expect((await result).status).toBe('error'); cleaned();
});

test('a failed stop cannot certify capability even with valid native proof', async () => {
  fixture(); fixtures.stop.mockRejectedValue(new Error('private diagnostic'));
  expect((await probe()).status).toBe('error'); cleaned();
});

test.each([
 ['codex','responses'],['opencode','responses'],['opencode','chat-completions'],['opencode','anthropic-messages'],['deepseek-harness','chat-completions'],
] as const)('%s %s writes through its pinned native protocol', async (agentId, protocol) => {
 fixtures.relay.mockImplementation(async (config,input,stdout) => {
   execution=config;
   if (agentId==='deepseek-harness') stdout.write(JSON.stringify({v:1,type:'ready',runtime:'open-design',protocol_version:1,plugin_version:'1.0.0',capabilities:{session_resume:true,session_cancel:true,structured_events:true}})+'\n');
   let message='';
   if (agentId==='deepseek-harness') {
     const chunk=await input[Symbol.asyncIterator]().next();
     const command=JSON.parse(String(chunk.value));
     expect(command).toMatchObject({v:1,type:'execute',model:{provider:'deepseek-official',id:'native-model'}});
     message=command.prompt;
   } else { for await(const chunk of input) message+=chunk; }
   const file=path.join(config.execution.cwd,'nonce.txt');expect(existsSync(file)).toBe(false);
   writeFileSync(file,/[a-f0-9]{64}/.exec(message)![0]);
   if (agentId==='deepseek-harness') {
     stdout.write(JSON.stringify({v:1,type:'session',request_id:config.execution.executionId,session_id:'probe-session',resumed:false})+'\n');
     stdout.write(JSON.stringify({v:1,type:'result',request_id:config.execution.executionId,session_id:'probe-session',status:'completed',resume_rejected:false})+'\n');
   } else stdout.write(JSON.stringify(agentId==='codex'?{type:'turn.completed'}:{type:'step_finish',part:{reason:'stop'}})+'\n');
   return 0;
 });
 const result=await createNativeCompanyModelProbe({dataRoot:root,proxyUrl:'http://proxy',proxySecret:'control',executorUrl:'http://executor',executorSecret:'control'})({...request,agentId,protocol});
 expect(result).toMatchObject({status:'supported',testedBy:agentId,verification:'file-write'});
 expect(execution.execution).toMatchObject({agentId,protocol});expect(lease).toMatchObject({agentId,wireProtocol:protocol});cleaned();
});

test.each([
 ['malformed trailing frame', '\n{not-json}\n', 'error'],
 ['incomplete EOF tail', '\n{"v":', 'error'],
 ['complete final frame without newline', '', 'supported'],
] as const)('DSH admission validates %s after writing the exact file', async (_label, tail, expected) => {
 let wroteFile = false;
 fixtures.relay.mockImplementation(async (config,input,stdout) => {
   stdout.write(JSON.stringify({v:1,type:'ready',runtime:'open-design',protocol_version:1,plugin_version:'1.0.0',capabilities:{session_resume:true,session_cancel:true,structured_events:true}})+'\n');
   const chunk=await input[Symbol.asyncIterator]().next();
   const command=JSON.parse(String(chunk.value));
   const file=path.join(config.execution.cwd,'nonce.txt');
   expect(existsSync(file)).toBe(false);
   writeFileSync(file,/[a-f0-9]{64}/.exec(command.prompt)![0]); wroteFile = true;
   stdout.write(JSON.stringify({v:1,type:'session',request_id:config.execution.executionId,session_id:'probe-session',resumed:false})+'\n');
   stdout.write(JSON.stringify({v:1,type:'result',request_id:config.execution.executionId,session_id:'probe-session',status:'completed',resume_rejected:false})+tail);
   return 0;
 });
 const result=await createNativeCompanyModelProbe({dataRoot:root,proxyUrl:'http://proxy',proxySecret:'control',executorUrl:'http://executor',executorSecret:'control'})({...request,agentId:'deepseek-harness',protocol:'chat-completions'});
 expect(wroteFile).toBe(true);
 expect(result.status).toBe(expected);
 if (tail) expect(JSON.stringify(result)).not.toContain(tail);
 cleaned();
});
