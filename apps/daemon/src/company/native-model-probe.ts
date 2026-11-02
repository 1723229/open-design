import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, lstatSync, realpathSync, openSync, readSync, fstatSync, closeSync, constants } from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { encodeStreamJsonUserMessage } from '../runtimes/run-steering.js';
import { StringDecoder } from 'node:string_decoder';
import type { CompanyModelCapability } from '@open-design/contracts';
import { companyProjectHome } from './container-execution.js';
import { relayCompanyExecution, stopCompanyExecution, type CompanyBridgeRequest } from './executor-client.js';
import { registerCompanyModelLease, revokeCompanyModelLease } from './model-proxy.js';
import type { ChildProcess } from 'node:child_process';
import { getAgentDef } from '../runtimes/registry.js';
import { attachDshProfileSession, createDshProfileJsonlStream } from '../agent-protocol/dsh-profile/index.js';
import { COMPANY_MODEL_AGENTS } from './model-settings.js';
import type { ProbeRequest } from './model-probe.js';

interface NativeProbeRuntime {
  dataRoot: string;
  proxyUrl: string;
  proxySecret: string;
  executorUrl: string;
  executorSecret: string;
  timeoutMs?: number;
}
/** Prove a native file write in a disposable executor workspace; the provider key stays in the proxy. */
export function createNativeCompanyModelProbe(runtime: NativeProbeRuntime) {
  return async (request: ProbeRequest & { signal?: AbortSignal }): Promise<CompanyModelCapability> => {
    const result = (status: CompanyModelCapability['status']): CompanyModelCapability => ({
      model: request.model, protocol: request.protocol, status, ...(request.agentId ? {testedBy: request.agentId} : {}), verification: 'file-write', checkedAt: (request.now ?? Date.now)(),
      ...(status === 'supported' ? {} : {message:'Native Agent file-write capability could not be verified.'}),
    });
    const agent = COMPANY_MODEL_AGENTS.find(a => a.id === request.agentId);
    const def = agent && getAgentDef(agent.id);
    if (!agent || !def || !agent.protocols.includes(request.protocol)) return result('unsupported');
    const id = `native-probe-${randomUUID()}`;
    const dataRoot = path.resolve(runtime.dataRoot);
    const project = path.join(dataRoot, 'projects', id);
    const home = companyProjectHome(dataRoot, id);
    const target = path.join(project, 'nonce.txt');
    const nonce = randomBytes(32).toString('hex');
    const timeoutMs = runtime.timeoutMs ?? 90_000;
    const token = randomBytes(32).toString('base64url');
    const bridge: CompanyBridgeRequest = {
      url:runtime.executorUrl, secret:runtime.executorSecret,
      execution:{executionId:id,jobId:id,projectId:id,agentId:agent.id,model:request.model,protocol:request.protocol,token,expiresAt:Date.now()+timeoutMs,
        cwd:project,env:{},inputMode:agent.id === 'deepseek-harness' ? 'stream' : 'complete',
        args:def.buildArgs('', [], [], {model:request.model}, {cwd:project})},
    };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal?.addEventListener('abort', cancel, {once:true});
    if (request.signal?.aborted) cancel();
    const timer = setTimeout(cancel, timeoutMs);
    let outcome = result('error');
    let ownedProject = false; let ownedHome = false;
    try {
      controller.signal.throwIfAborted();
      mkdirSync(path.dirname(project),{recursive:true}); mkdirSync(project,{mode:0o700}); ownedProject = true;
      mkdirSync(path.dirname(home),{recursive:true}); mkdirSync(home,{mode:0o700}); ownedHome = true;
      await registerCompanyModelLease(runtime.proxyUrl,runtime.proxySecret,{
        id,token,agentId:agent.id,model:request.model,baseUrl:request.baseUrl,apiKey:request.apiKey,
        protocol:request.protocol === 'anthropic-messages' ? 'anthropic' : 'openai',wireProtocol:request.protocol,expiresAt:Date.now()+timeoutMs,
      });
      controller.signal.throwIfAborted();
      const prompt = `Create the UTF-8 file ${target} using your file writing tool. Its exact contents must be ${nonce} with no newline or other text. The file does not exist yet. Do not merely print the contents; write the file, then finish.`;
      const dsh = agent.id === 'deepseek-harness';
      const input = dsh ? new PassThrough() : Readable.from([def.promptInputFormat === 'stream-json' ? encodeStreamJsonUserMessage(prompt) : prompt]);
      const dshOutput = new PassThrough();
      // Admission validates the whole stream, including framing errors after a completed session.
      const dshFrames = dsh ? createDshProfileJsonlStream({onFrame:()=>{},onError:()=>{}}) : undefined;
      const session = dsh ? attachDshProfileSession({ child: {stdin:input,stdout:dshOutput} as unknown as ChildProcess,
        requestId:id,prompt,cwd:project,model:`deepseek-official/${request.model}`,send:()=>{} }) : undefined;
      let stdout = ''; let bytes = 0; const decoder = new StringDecoder('utf8');
      const output = (retain: boolean) => new Writable({write(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 1024*1024) controller.abort();
        else if (retain) { if (dsh) { dshFrames!.feed(chunk); dshOutput.write(chunk); } else stdout += decoder.write(chunk); }
        callback();
      }});
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve,reject) => {
        abort = () => reject(new Error('Native probe interrupted'));
        controller.signal.addEventListener('abort',abort,{once:true});
      });
      try {
        const code = await Promise.race([relayCompanyExecution(bridge,input,output(true),output(false),controller.signal),cancelled]);
        controller.signal.throwIfAborted();
        stdout += decoder.end();
        if (dsh) { const ended = once(dshOutput, 'end'); dshOutput.end(); await ended; }
        dshFrames?.flush();
        let terminalOk = (session?.completedSuccessfully() ?? false) && !dshFrames?.hasFailed();
        if (!dsh) {
          if (!stdout.endsWith('\n')) throw new Error('Truncated native output');
          const events = stdout.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
          const terminal = events.at(-1);
          terminalOk = agent.id === 'claude' ? terminal?.type === 'result' && terminal.subtype === 'success' && terminal.is_error === false
            : agent.id === 'codex' ? terminal?.type === 'turn.completed'
            : terminal?.type === 'step_finish' && terminal.part?.reason === 'stop';
        }
        if (code === 0 && terminalOk && realpathSync(project) === project) {
          const stat = lstatSync(target);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(nonce) || realpathSync(target) !== target) throw new Error('Invalid proof file');
          const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const actual = fstatSync(fd);
            const contents = Buffer.alloc(Buffer.byteLength(nonce) + 1);
            const size = readSync(fd, contents, 0, contents.length, 0);
            if (actual.ino === stat.ino && actual.dev === stat.dev && actual.size === stat.size && size === Buffer.byteLength(nonce) && contents.subarray(0,size).toString('utf8') === nonce) outcome = result('supported');
          } finally { closeSync(fd); }
        }
      } finally {
        controller.signal.removeEventListener('abort',abort);
        controller.abort(); input.destroy(); dshOutput.destroy();
      }
    } catch { /* Public diagnostics never contain CLI output or transport credentials. */ }
    finally {
      clearTimeout(timer); request.signal?.removeEventListener('abort',cancel);
      try { await stopCompanyExecution(bridge); } catch { outcome = result('error'); }
      try { await revokeCompanyModelLease(runtime.proxyUrl,runtime.proxySecret,id); } catch { outcome = result('error'); }
      // Only generated, successfully created children of the supplied data root are disposable.
      for (const directory of [ownedProject ? project : null,ownedHome ? home : null]) {
        if (!directory) continue;
        const relative = path.relative(dataRoot,directory);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { outcome = result('error'); continue; }
        try { rmSync(directory,{recursive:true,force:true}); } catch { outcome = result('error'); }
      }
    }
    return outcome;
  };
}
