import { mkdirSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { db } from '../../apps/api/db.mjs';
import { config, root } from '../../apps/api/config.mjs';
const output=path.join(root,'storage/backups',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(output,{recursive:true});
const dbFile=path.join(output,'store.sqlite');
// VACUUM INTO produces a consistent SQLite snapshot even when WAL is in use.
db.exec("VACUUM INTO '"+dbFile.replace(/'/g,"''")+"'");
cpSync(config.mediaDir,path.join(output,'media'),{recursive:true});
const KEY_FILES=['fx-credentials.key','translation-credentials.key','whatsapp-credentials.key','payment-credentials.key','oms-credentials.key','tracking17-credentials.key','email-credentials.key','oauth-credentials.key','image-search-fallback-credentials.key','catalog-sync-credentials.key'];
for(const name of KEY_FILES){
  const source=path.join(path.dirname(config.dbPath),name);
  if(existsSync(source))cpSync(source,path.join(output,name));
}
writeFileSync(path.join(output,'README.txt'),'数据库、媒体和接口凭据加密文件备份。还原前先停止网站，并备份当前数据；将 store.sqlite 和 media 恢复到对应持久化目录。若备份内含 *-credentials.key 密钥文件，须全部放回数据库同目录，且与数据库成套恢复，否则对应接口（汇率、翻译、WhatsApp、支付、OMS、17TRACK、邮件、Google 登录、图搜兜底、同步令牌）无法解密。备份含个人信息和密钥，勿公开。\n');
console.log(output);db.close();
