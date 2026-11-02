import fs from 'node:fs';
import { relayCompanyExecution, stopCompanyExecution, type CompanyBridgeRequest } from './executor-client.js';

const file = process.argv[2];
if (!file) throw new Error('Missing executor request file');
const config = JSON.parse(fs.readFileSync(file, 'utf8')) as CompanyBridgeRequest;
fs.unlinkSync(file);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { void stopCompanyExecution(config).finally(() => process.exit(143)); });
}
try {
  process.exitCode = await relayCompanyExecution(config, process.stdin, process.stdout, process.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
process.stdin.pause();
