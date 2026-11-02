import { afterEach, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, existsSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNativeCompanyModelProbe } from '../../src/company/native-model-probe.js';
import { createCompanyModelProxy } from '../../src/company/model-proxy.js';
import type { ExecutorWireRequest } from '../../src/company/executor-server.js';
const servers: Server[] = []; const roots: string[] = [];
afterEach(async()=>{
  for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); } servers.length=0;
  for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
});
async function listen(server: Server) {
  servers.push(server); await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
}
test('native probe relays complete stdin and scoped auth over the actual private HTTP boundaries', async()=>{
  const root = mkdtempSync(path.join(tmpdir(),'native-http-')); roots.push(root);
  const upstream = await listen(createServer((req,res)=>{expect(req.headers['x-api-key']).toBe('real-private-key'); res.end('{}');}));
  const proxy = await listen(createCompanyModelProxy({controlSecret:'proxy-control'}));
  let token = ''; let stopped = false; let nonce = '';
  const executor = await listen(createServer(async(req,res)=>{
    expect(req.headers.authorization).toBe('Bearer executor-control');
    if (req.method==='DELETE') { stopped=true; res.end('ok'); return; }
    let body=''; for await(const chunk of req) body+=chunk;
    expect(body).not.toContain('real-private-key');
    const [line,...stdin] = body.trim().split('\n'); const execution = JSON.parse(line!) as ExecutorWireRequest;
    expect(execution.inputMode).toBe('complete'); expect(execution.env).toEqual({}); token=execution.token;
    const target=path.join(execution.cwd,'nonce.txt'); expect(existsSync(target)).toBe(false); nonce=/[a-f0-9]{64}/.exec(JSON.parse(stdin[0]!).message.content[0].text)![0]; writeFileSync(target,nonce);
    expect(stdin).toHaveLength(1); expect(JSON.parse(stdin[0]!).message.content[0].text).toContain(target); expect(body).toContain(nonce);
    const provider = await fetch(`${proxy}/v1/messages?beta=true`,{method:'POST',headers:{'x-api-key':token,'content-type':'application/json'},body:JSON.stringify({model:execution.model})});
    expect(provider.status).toBe(200); await provider.body?.cancel();
    res.setHeader('content-type','application/x-ndjson');
    const output=[{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'read',name:'Read',input:{file_path:target}}]}},{type:'result',subtype:'success',is_error:false,result:nonce}].map(e=>JSON.stringify(e)+'\n').join('');
    res.end(JSON.stringify({type:'stdout',data:Buffer.from(output).toString('base64')})+'\n'+JSON.stringify({type:'exit',code:0})+'\n');
  }));
  const result = await createNativeCompanyModelProbe({dataRoot:root,proxyUrl:proxy,proxySecret:'proxy-control',executorUrl:executor,executorSecret:'executor-control'})({agentId:'claude',model:'m',protocol:'anthropic-messages',baseUrl:upstream,apiKey:'real-private-key'});
  expect(result.status).toBe('supported'); expect(stopped).toBe(true); expect(JSON.stringify(result)).not.toContain(nonce);
  expect(readdirSync(path.join(root,'projects'))).toEqual([]); expect(readdirSync(path.join(root,'agent-homes'))).toEqual([]);
  expect((await fetch(`${proxy}/v1/messages`,{method:'POST',headers:{'x-api-key':token},body:'{}'})).status).toBe(401);
});
