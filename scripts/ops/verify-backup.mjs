import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
const dir=process.argv[2];
if(!dir){console.error('用法：node scripts/ops/verify-backup.mjs 备份目录');process.exitCode=1;}
else{
  let backup;
  try{
    backup=new DatabaseSync(path.join(dir,'store.sqlite'),{readOnly:true});
    const integrity=backup.prepare('PRAGMA integrity_check').get();
    if(Object.values(integrity)[0]!=='ok')throw new Error('数据库完整性检查失败');
    const foreignKeys=backup.prepare('PRAGMA foreign_key_check').all();
    if(foreignKeys.length)throw new Error('数据库存在外键错误');
    const missing=backup.prepare('SELECT path FROM media').all().filter(m=>!existsSync(path.join(dir,'media',path.basename(m.path))));
    if(missing.length)throw new Error('备份缺少媒体文件：'+missing.length);
    const counts=Object.fromEntries(['products','collections','media','orders','users'].map(table=>[table,backup.prepare('SELECT COUNT(*) count FROM '+table).get().count]));
    console.log(JSON.stringify({integrity:'ok',foreignKeys:'ok',media:'ok',counts},null,2));
  }catch(err){console.error(err.message);process.exitCode=1;}finally{backup?.close();}
}
