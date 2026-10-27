export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function text(value, label, max = 200, required = true) {
  if (typeof value !== 'string') throw new InputError(`${label}格式错误`);
  const s = value.trim();
  if ((required && !s) || s.length > max) throw new InputError(`${label}不能为空且最多 ${max} 字符`);
  return s;
}
export function email(value) {
  const s = text(value, '邮箱', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new InputError('请输入有效邮箱');
  return s;
}
export function int(value, label, min = 0, max = 1_000_000_000) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new InputError(`${label}应为 ${min} 至 ${max} 的整数`);
  return n;
}
export function cents(value, label = '价格') {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(String(value))) throw new InputError(`${label}最多保留两位小数`);
  const [whole, frac = ''] = String(value).split('.');
  return int(Number(whole) * 100 + Number(frac.padEnd(2, '0')), label);
}
export function slug(value) {
  const s = text(value, '网址标识', 250);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) throw new InputError('网址标识只能包含小写英文、数字和连字符');
  return s;
}
export function localImage(value) {
  const s = text(value || '', '图片路径', 200, false);
  if (s && !/^\/media\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(s)) throw new InputError('请选择媒体库中的图片');
  return s;
}
export function safeLink(value) {
  const s = text(value, '链接', 300);
  if (!/^\/(?!\/)[a-zA-Z0-9\-_/?.=&%]*$/.test(s)) throw new InputError('链接必须是站内路径');
  return s;
}
