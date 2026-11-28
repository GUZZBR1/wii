import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { receiveRecording } from '../scripts/auto-upgrade-plugin';

describe('auto-upgrade inbox', () => {
  let inbox: string;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    inbox = await mkdtemp(join(tmpdir(), 'inbox-'));
    server = createServer(receiveRecording(inbox));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.close();
    await rm(inbox, { recursive: true, force: true });
  });

  it('stores a posted match under a name it chooses', async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(response.status).toBe(204);
    const [file, ...rest] = await readdir(inbox);
    expect(rest).toEqual([]);
    expect(file).toMatch(/^match-\d+\.json$/);
    expect(await readFile(join(inbox, file!), 'utf8')).toBe('{"a":1}');
  });

  it('refuses what a cross-site page could send without a preflight', async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    expect(response.status).toBe(415);
    expect(await readdir(inbox)).toEqual([]);
  });
});
