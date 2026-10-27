import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
export const random = (bytes = 32) => randomBytes(bytes).toString('hex');
export const hash = v => createHash('sha256').update(v).digest('hex');
export function passwordHash(password) {
  const salt = random(16);
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordVerify(password, stored) {
  const [type, salt, expected] = stored.split(':');
  if (type !== 'scrypt' || !salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const target = Buffer.from(expected, 'hex');
  return actual.length === target.length && timingSafeEqual(actual, target);
}
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attempts = new Map();
export function limited(key, max = 15, window = 15 * 60 * 1000) {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.expires < now) attempts.delete(k);
  const a = attempts.get(key) || {count: 0, expires: now + window};
  a.count++; attempts.set(key, a);
  return a.count > max;
}
