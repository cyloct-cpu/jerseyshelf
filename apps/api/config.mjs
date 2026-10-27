import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3001),
  dbPath: path.resolve(root, process.env.DATABASE_PATH || 'storage/store.sqlite'),
  mediaDir: path.resolve(root, process.env.MEDIA_PATH || 'storage/media'),
  secure: process.env.COOKIE_SECURE === 'true',
  trustLocalProxy: process.env.TRUST_LOCAL_PROXY === 'true'
};
