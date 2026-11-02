import { createServer, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import { createLdapDirectory } from '../../src/company/auth.js';

async function firstPacket(options: { scheme?: 'ldap' | 'ldaps'; startTls?: boolean; verifyTls: boolean }) {
  const sockets = new Set<Socket>();
  let receive!: (packet: Buffer) => void;
  const packet = new Promise<Buffer>((resolve) => { receive = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', (data) => { receive(Buffer.from(data)); socket.destroy(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const directory = createLdapDirectory({
    url: `${options.scheme ?? 'ldap'}://127.0.0.1:${address.port}`,
    baseDn: 'ou=people,dc=test', bindDn: 'cn=service,dc=test', bindPassword: 'service-test-password',
    userFilter: '(uid={username})', usernameAttribute: 'uid', entryUUIDAttribute: 'entryUUID', displayNameAttribute: 'cn',
    startTls: options.startTls ?? false, verifyTls: options.verifyTls,
    connectTimeoutMs: 2000, searchTimeoutMs: 2000, autoCreate: true,
  });
  const authentication = directory.authenticate('employee', 'employee-test-password').catch(() => null);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      packet,
      new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('LDAP client sent no packet')), 3000); }),
    ]);
  } finally {
    clearTimeout(deadline);
    for (const socket of sockets) socket.destroy();
    await authentication;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it.each([false, true])('starts ldap:// with a plain LDAP bind when verifyTls=%s', async (verifyTls) => {
  const packet = await firstPacket({ verifyTls });
  expect(packet[0]).toBe(0x30);
  expect(packet.includes(Buffer.from('cn=service,dc=test'))).toBe(true);
});

it('starts ldaps:// with a TLS handshake', async () => {
  const packet = await firstPacket({ scheme: 'ldaps', verifyTls: false });
  expect(packet[0]).toBe(0x16);
  expect(packet.includes(Buffer.from('service-test-password'))).toBe(false);
});

it('requests StartTLS before sending LDAP bind credentials', async () => {
  const packet = await firstPacket({ startTls: true, verifyTls: false });
  expect(packet[0]).toBe(0x30);
  expect(packet.includes(Buffer.from('1.3.6.1.4.1.1466.20037'))).toBe(true);
  expect(packet.includes(Buffer.from('cn=service,dc=test'))).toBe(false);
});
