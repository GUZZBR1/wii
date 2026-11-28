import { mkdir, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export const AUTO_UPGRADE_ROUTE = '/__auto-upgrade';
const MAX_BYTES = 100 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Receives one recorded segment and drops it in `inbox`. Only this machine may post, only as JSON
 * (another site cannot send that without a CORS preflight), and the server picks the file name.
 */
export function receiveRecording(inbox: string) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const reply = (status: number): void => { response.writeHead(status).end(); };
    if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) { reply(403); return; }
    if (request.method !== 'POST') { reply(405); return; }
    if (!request.headers['content-type']?.startsWith('application/json')) { reply(415); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BYTES) chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > MAX_BYTES) return reply(413);
      const name = `match-${Date.now()}`;
      const partial = join(inbox, `${name}.part`);
      // The rename makes the .json appear only once it is complete, so a watcher never reads half.
      void mkdir(inbox, { recursive: true })
        .then(() => writeFile(partial, Buffer.concat(chunks)))
        .then(() => rename(partial, join(inbox, `${name}.json`)))
        .then(() => reply(204), () => reply(500));
    });
  };
}

/** Dev server only, and only when started with `npm run auto-upgrade`. */
export function autoUpgradePlugin(inbox: string): Plugin {
  return {
    name: 'auto-upgrade-inbox',
    apply: 'serve',
    configureServer(server) {
      if (process.env.VITE_AUTO_UPGRADE !== '1') return;
      server.middlewares.use(AUTO_UPGRADE_ROUTE, receiveRecording(inbox));
    },
  };
}
