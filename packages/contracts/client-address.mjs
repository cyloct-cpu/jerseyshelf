import { isIP } from 'node:net';

export function clientAddress(req, trustLocalProxy = false) {
  const peer = req.socket.remoteAddress;
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
  const forwarded = req.headers['x-real-ip'];
  if (trustLocalProxy && local && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return peer;
}
