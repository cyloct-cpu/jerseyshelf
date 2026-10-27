import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { db, now } from './db.mjs';
import { hash } from './security.mjs';
import { InputError, text } from '../../packages/contracts/validation.mjs';
export function saveMedia(bytes, name, source='', maxBytes=8*1024*1024) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxBytes)throw new InputError('图片大小超出限制');
  let ext,type;
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){ext='png';type='image/png';}
  else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255){ext='jpg';type='image/jpeg';}
  else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'){ext='webp';type='image/webp';}
  else if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())){ext='gif';type='image/gif';}
  else throw new InputError('仅支持 PNG、JPG、WebP、GIF 图片，不支持 SVG 或脚本文件');
  const digest=hash(bytes), mediaPath='/media/'+digest+'.'+ext;
  writeFileSync(path.join(config.mediaDir,digest+'.'+ext),bytes);
  db.prepare('INSERT OR IGNORE INTO media(path,name,content_type,bytes,hash,source_url,created_at) VALUES(?,?,?,?,?,?,?)').run(mediaPath,text(name,'文件名',200),type,bytes.length,digest,source,now());
  return db.prepare('SELECT * FROM media WHERE hash=?').get(digest);
}
