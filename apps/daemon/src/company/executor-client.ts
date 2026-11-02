import http from 'node:http';
import https from 'node:https';
import type { Readable, Writable } from 'node:stream';
import type { ExecutorWireRequest } from './executor-server.js';

export interface CompanyBridgeRequest {
  url: string;
  secret: string;
  execution: ExecutorWireRequest;
}

/** Preserve the existing CLI wire protocol byte for byte across the manager boundary. */
export function relayCompanyExecution(config: CompanyBridgeRequest, input: Readable, output: Writable, errors: Writable, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL('/executions', config.url);
    const transport = endpoint.protocol === 'https:' ? https : http;
    const request = transport.request(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/octet-stream' }, ...(signal ? {signal} : {}),
    }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Execution manager returned HTTP ${response.statusCode}`)); return; }
      let pending = '';
      let code = 1;
      let sourceEnded = false;
      const blocked = new Set<Writable>();
      response.setEncoding('utf8');
      const finish = () => {
        if (sourceEnded && blocked.size===0 && pending.length===0) {input.unpipe(request);input.pause();request.end();resolve(code);}
      };
      const consume = () => {
        while (blocked.size===0) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const event = JSON.parse(pending.slice(0, newline)) as { type: string; data?: string; code?: number };
          pending = pending.slice(newline + 1);
          const destination = event.type==='stdout'?output:event.type==='stderr'?errors:null;
          if (destination && !destination.write(Buffer.from(event.data ?? '','base64'))) {
            blocked.add(destination);response.pause();
            destination.once('drain',()=>{blocked.delete(destination);consume();if(!blocked.size)response.resume();});
          }
          if (event.type === 'exit') code = event.code ?? 1;
        }
        finish();
      };
      response.on('data', (chunk: string) => {
        pending += chunk;
        try { consume(); } catch (error) { response.destroy(); reject(error); }
      });
      response.once('error', reject);
      response.once('end', () => { sourceEnded=true;finish(); });
    });
    request.once('error', reject);
    request.write(`${JSON.stringify(config.execution)}\n`);
    input.pipe(request);
  });
}

export async function stopCompanyExecution(config: CompanyBridgeRequest): Promise<void> {
  const response = await fetch(new URL(`/executions/${encodeURIComponent(config.execution.executionId)}`, config.url), {
    method: 'DELETE', headers: { authorization: `Bearer ${config.secret}` }, signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Unable to stop company execution');
}
