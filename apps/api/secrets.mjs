import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';
import { config } from './config.mjs';
import { InputError } from '../../packages/contracts/validation.mjs';

// 共享密钥封存：AES-256-GCM + 数据库同目录密钥文件（模式与 fx/translation 凭据一致）。
const files = new Map();
function keyFile(name) {
  if (!files.has(name)) files.set(name, path.join(path.dirname(config.dbPath), name + '.key'));
  return files.get(name);
}
function secretKey(name, create = false) {
  const file = keyFile(name);
  if (!existsSync(file)) { if (!create) throw new Error('密钥文件缺失：' + name); writeFileSync(file, randomBytes(32), { mode: 0o600 }); }
  return readFileSync(file);
}
export function sealTo(name, value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secretKey(name, true), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function unsealFrom(name, value, message = '密钥无法读取，请在后台重新配置') {
  try {
    const raw = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', secretKey(name), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch { throw new InputError(message, 503); }
}
