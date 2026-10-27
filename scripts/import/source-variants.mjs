import { db, transaction, now, audit } from '../../apps/api/db.mjs';
import { cents, text } from '../../packages/contracts/validation.mjs';
export function backfillSourceVariants(products){
  const report={updatedProducts:0,newVariants:0,skippedProducts:0};
  transaction(()=>{for(const source of products){
    const p=db.prepare('SELECT p.* FROM products p JOIN source_products s ON s.product_id=p.id WHERE s.source_id=?').get(source.id);
    if(!p||p.source_status!=='homepage-only'||!source.variants?.length){report.skippedProducts++;continue;}
    const old=db.prepare('SELECT * FROM variants WHERE product_id=?').all(p.id);
    if(!old.length||old.some(v=>!/^UNVERIFIED-\d+$/.test(v.sku)||v.active||v.stock)){report.skippedProducts++;continue;}
    if(source.variants.length>100)throw new Error('来源规格超出数量限制');
    for(const v of source.variants){
      if(!/^[a-f0-9-]{36}$/.test(v.id))throw new Error('来源规格 ID 格式无效');
      const id=Number(db.prepare('INSERT INTO variants(product_id,sku,label,price,stock,active) VALUES(?,?,?,?,0,?)').run(p.id,'SRC-'+v.id,text(v.title||'默认规格','来源规格',100),cents(v.price??String(p.price/100)),v.available===false?0:1).lastInsertRowid);
      db.prepare('INSERT INTO source_variants VALUES(?,?)').run(v.id,id);report.newVariants++;
    }
    db.prepare('UPDATE products SET updated_at=? WHERE id=?').run(now(),p.id);report.updatedProducts++;
  }audit(null,'source.variants-backfill',JSON.stringify(report));});
  return report;
}
