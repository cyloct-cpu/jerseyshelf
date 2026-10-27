import { db, now, transaction } from '../../apps/api/db.mjs';
const national = [['argentina','阿根廷'],['mexico','墨西哥'],['netherlands','荷兰'],['england','英格兰'],['japan','日本'],['portugal','葡萄牙'],['italy','意大利'],['france','法国'],['germany','德国'],['brazil','巴西'],['spain','西班牙'],['wales','威尔士']];
const clubs = [['paris','巴黎'],['real-madrid','皇家马德里'],['bayern','拜仁慕尼黑'],['barcelona','巴塞罗那'],['arsenal','兵工厂'],['juventus','尤文图斯'],['manchester-united','曼联'],['manchester-city','曼城'],['liverpool','利物浦'],['chelsea','切尔西'],['inter-milan','国际米兰'],['ac-milan','AC米兰']];
const other = [['2026-27-season','2026-27赛季'],['2025-26season','2025-26赛季'],['retro','复古的'],['kids-size','儿童尺码'],['autumn-and-winter-series','秋冬季'],['trench-coat','风衣'],['shorts','短裤']];
const products = [
['2026-27-bayern-munich-away-kit-fan-edition','2026-27赛季拜仁慕尼黑客场球衣 - 球迷版',17,35.9,'2026-27-season','bayern'],
['2024-25-arsenal-goalkeeper-training-jersey-sdgg','2026-27赛季阿森纳主场球衣 - 球迷版',17,35.9,'2026-27-season','arsenal'],
['2026-27-barcelona-away-jersey-fan-version','2026-27赛季巴塞罗那客场球衣 - 球迷版',17,35.9,'2026-27-season','barcelona'],
['2025-26-arsenal-away-shirt-mcz5','2026-27赛季阿森纳客场球衣',17,35.9,'2026-27-season','arsenal'],
['2026-27-arsenal-second-away-kit-fan-edition','2026-27赛季阿森纳第二客场球衣 - 球迷版',17,35.9,'2026-27-season','arsenal'],
['2025-26-liverpool-casual-jersey-8vl9','2026-27赛季利物浦主场球衣 - 球迷版',17,35.9,'2026-27-season','liverpool'],
['2013-14-manchester-united-white-retro-jersey','2013-14赛季曼联白色复古球衣',21,47.9,'retro','manchester-united'],
['2005-06-arsenal-home-long-sleeve-retro-shirt','2005-06赛季阿森纳主场长袖复古球衣',24,51.9,'retro','arsenal'],
['2005-06-arsenal-home-retro-shirt-kids-sizes','2005-06赛季阿森纳主场复古球衣 - 儿童尺码',18,35.9,'retro','arsenal'],
['2005-06-arsenal-home-retro-jersey','2005-06赛季阿森纳主场复古球衣',21,47.9,'retro','arsenal'],
['1998-99-manchester-united-home-retro-jersey','1998-99赛季曼联主场复古球衣',21,47.9,'retro','manchester-united'],
['2011-12-real-madrid-yellow-goalkeeper-retro-shirt-kids','2011-12赛季皇家马德里黄色守门员复古球衣 - 儿童款',18,35.9,'retro','real-madrid'],
['2025-26-adidas-casual-trench-coat-v9tw','2025-26 阿迪达斯休闲风衣',40,129,'trench-coat'],
['2025-26-barcelona-trench-coat','2025-26 巴塞罗那风衣',40,129,'trench-coat','barcelona']
];
export function seed() {
  if(db.prepare('SELECT id FROM products LIMIT 1').get()) return;
  transaction(()=>{
    let pos=0;
    for(const [list,kind] of [[national,'national'],[clubs,'club'],[other,'other']]) for(const [slug,name] of list) db.prepare('INSERT OR IGNORE INTO collections(slug,name,kind,position) VALUES(?,?,?,?)').run(slug,name,kind,pos++);
    for(const [slug,title,price,compare,...cats] of products){
      const id=Number(db.prepare('INSERT INTO products(slug,title,price,compare_price,source_url,source_status,updated_at) VALUES(?,?,?,?,?,?,?)').run(slug,title,Math.round(price*100),Math.round(compare*100),'https://www.chenyikan.shop/products/'+slug,'homepage-only',now()).lastInsertRowid);
      // Unknown source sizes and inventory must not be fabricated. Create an unavailable default variant until verified/imported.
      db.prepare('INSERT INTO variants(product_id,sku,label,price,stock,active) VALUES(?,?,?,?,?,?)').run(id,'UNVERIFIED-'+id,'规格待核实',Math.round(price*100),0,0);
      for(const cat of cats){ const c=db.prepare('SELECT id FROM collections WHERE slug=?').get(cat); if(c)db.prepare('INSERT INTO product_collections VALUES(?,?)').run(id,c.id); }
    }
  });
}
