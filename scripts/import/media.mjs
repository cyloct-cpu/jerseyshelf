import { readFileSync } from 'node:fs';
import path from 'node:path';
import { saveMedia } from '../../apps/api/media.mjs';
import { db } from '../../apps/api/db.mjs';
const files=process.argv.slice(2);
if(!files.length){console.error('用法：node scripts/import/media.mjs 图片文件 [...]');process.exitCode=1;}
for(const file of files){try{const m=saveMedia(readFileSync(file),path.basename(file));console.log(JSON.stringify({file,path:m.path}));}catch(err){console.error(file+': '+err.message);process.exitCode=1;}}
db.close();
