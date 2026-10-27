import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../apps/api/config.mjs';
import { createHash } from 'node:crypto';
import { db } from '../../apps/api/db.mjs';
import { customizationContext } from '../../apps/api/customization.mjs';

const file=new URL('../../data/manifests/default-customization-change.json',import.meta.url);
const prior=JSON.parse(readFileSync(file,'utf8'));
const digest=sql=>createHash('sha256').update(JSON.stringify(db.prepare(sql).all())).digest('hex');
const current={products:digest('SELECT id,price,compare_price,images,customization FROM products ORDER BY id'),variants:digest('SELECT * FROM variants ORDER BY id'),orderItems:digest('SELECT * FROM order_items ORDER BY id')};
const groups=new Map();
for(const c of db.prepare('SELECT pc.product_id,c.kind FROM product_collections pc JOIN collections c ON c.id=pc.collection_id WHERE c.deleted_at IS NULL').all()){
  if(!groups.has(c.product_id))groups.set(c.product_id,[]);
  groups.get(c.product_id).push({kind:c.kind});
}
const report={verifiedAt:new Date().toISOString(),products:0,printingEnabled:0,patchesEnabled:0,modes:{inherit:0,custom:0},templates:{club:0,national:0,custom:0},missingImages:[],preservedHashes:Object.fromEntries(Object.entries(current).map(([key,value])=>[key,value===prior.protectedHashes[key]]))};
const checked=new Set();
for(const p of db.prepare('SELECT id,customization,customization_mode,customization_template FROM products').all()){
  const context=customizationContext({...p,collections:groups.get(p.id)||[]}),c=context.config;
  report.products++;report.modes[context.mode]++;report.templates[context.mode==='custom'?'custom':context.key]++;
  if(c.printing.enabled)report.printingEnabled++;
  if(c.patches.enabled&&c.patches.options.some(p=>p.enabled))report.patchesEnabled++;
  for(const option of c.patches.options)if(option.image&&!checked.has(option.image)){
    checked.add(option.image);if(!db.prepare('SELECT id FROM media WHERE path=?').get(option.image)||!existsSync(path.join(config.mediaDir,path.basename(option.image))))report.missingImages.push(option.image);
  }
}
report.integrity=db.prepare('PRAGMA quick_check').get().quick_check;
report.foreignKeyErrors=db.prepare('PRAGMA foreign_key_check').all().length;
report.ok=report.printingEnabled===report.products&&report.patchesEnabled===report.products&&!report.missingImages.length&&report.integrity==='ok'&&!report.foreignKeyErrors&&Object.values(report.preservedHashes).every(Boolean);
writeFileSync(file,JSON.stringify({...prior,result:report},null,2));
console.log(JSON.stringify(report));db.close();if(!report.ok)process.exitCode=1;
