import { InputError } from '../../packages/contracts/validation.mjs';

// 最小 multipart/form-data 解析器（零依赖）。仅供后台批量导入上传使用。
// 返回 {fields:{name:value}, files:[{name,filename,contentType,data}]}。
export function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!boundaryMatch) throw new InputError('multipart 编码缺少 boundary', 400);
  const boundary = Buffer.from('--' + (boundaryMatch[1] || boundaryMatch[2]).trim());
  const fields = {}, files = [];
  let position = buffer.indexOf(boundary);
  while (position !== -1) {
    const next = buffer.indexOf(boundary, position + boundary.length);
    if (next === -1) break;
    let chunk = buffer.subarray(position + boundary.length, next);
    if (chunk[0] === 13 && chunk[1] === 10) chunk = chunk.subarray(2);
    // 终止边界是 --boundary--，其后无头无体。
    if (chunk[0] === 45 && chunk[1] === 45) break;
    if (chunk[chunk.length - 2] === 13 && chunk[chunk.length - 1] === 10) chunk = chunk.subarray(0, -2);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd === -1) { position = next; continue; }
    const headers = chunk.subarray(0, headerEnd).toString('utf8');
    const body = chunk.subarray(headerEnd + 4);
    const nameMatch = /name="([^"]*)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
    if (fileMatch && fileMatch[1]) {
      files.push({ name: nameMatch?.[1] || '', filename: fileMatch[1], contentType: typeMatch?.[1]?.trim() || 'application/octet-stream', data: body });
    } else if (nameMatch) {
      fields[nameMatch[1]] = body.toString('utf8');
    }
    position = next;
  }
  return { fields, files };
}
