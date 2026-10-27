import { readFileSync } from 'node:fs';
import { importCatalog } from './service.mjs';
import { db } from '../../apps/api/db.mjs';
const file=process.argv[2];
if(!file){console.error('用法：node scripts/import/catalog.mjs 文件.json [--apply] [--overwrite]');process.exitCode=1;}
else{try{const data=JSON.parse(readFileSync(file,'utf8'));console.log(JSON.stringify(importCatalog(data,{dryRun:!process.argv.includes('--apply'),overwrite:process.argv.includes('--overwrite')}),null,2));}catch(err){console.error(err.message);process.exitCode=1;}}
db.close();
