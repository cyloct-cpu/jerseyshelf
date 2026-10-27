import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,statSync} from 'node:fs';
import path from 'node:path';
const db=new DatabaseSync('storage/store.sqlite',{readOnly:true});
const base='https://jerseyshelf.com';
let cookie='';
async function request(route,options={}){
  const res=await fetch(base+route,{redirect:'manual',signal:AbortSignal.timeout(30000),...options,headers:{cookie,...options.headers}});
  const incoming=res.headers.getSetCookie();
  if(incoming.length){
    const values=new Map(cookie.split('; ').filter(Boolean).map(v=>v.split(/=(.*)/s).slice(0,2)));
    for(const value of incoming){const pair=value.split(';')[0];const n=pair.indexOf('=');values.set(pair.slice(0,n),pair.slice(n+1));}
    cookie=[...values].map(([k,v])=>k+'='+v).join('; ');
  }
  return res;
}
const missing=db.prepare('SELECT path FROM media').all().filter(m=>!existsSync(path.join('storage/media',path.basename(m.path))));
assert.equal(missing.length,0,'All media must exist');
console.log('MEDIA_FILES_OK',db.prepare('SELECT count(*) n FROM media').get().n);
const product=db.prepare('SELECT p.slug,p.images,v.id variantId FROM products p JOIN variants v ON v.product_id=p.id WHERE p.active=1 AND v.active=1 AND v.stock>0 ORDER BY p.id LIMIT 1').get();
const category=db.prepare('SELECT slug FROM collections WHERE deleted_at IS NULL LIMIT 1').get();
for(const route of ['/', '/collections/'+category.slug, '/products/'+product.slug, '/search?q=jersey','/account','/track','/assets/store.css','/assets/store.js']){
  const res=await request(route);assert.equal(res.status,200,route);await res.arrayBuffer();console.log('GET_OK',route);
}
for(const route of JSON.parse(product.images)){
  const res=await request(route);assert.equal(res.status,200,route);assert.match(res.headers.get('content-type'),/^image\//);await res.arrayBuffer();
}
console.log('PRODUCT_GALLERY_OK');
const page=await request('/products/'+product.slug);const html=await page.text();
const csrf=html.match(/name="csrf" value="([^"]+)"/)?.[1];assert.ok(csrf);
const added=await request('/cart/add',{method:'POST',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,variantId:product.variantId,quantity:1})});
assert.ok([302,303].includes(added.status));assert.ok(added.headers.get('location').startsWith('/cart'));
const checkout=await request('/checkout');assert.equal(checkout.status,200);const checkoutHtml=await checkout.text();assert.match(checkoutHtml,/name="email"/);
console.log('CART_AND_CHECKOUT_OK_NO_ORDER_CREATED');
const admin=await request('/admin');assert.ok([302,303].includes(admin.status));assert.ok(admin.headers.get('location').startsWith('/account'));
console.log('ADMIN_AUTH_OK');
for(const url of ['http://jerseyshelf.com/','http://www.jerseyshelf.com/','https://www.jerseyshelf.com/']){
  const res=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(30000)});assert.equal(res.status,301);assert.equal(res.headers.get('location'),base+'/');console.log('REDIRECT_OK',url);
}
console.log('COUNTS',JSON.stringify({products:db.prepare('SELECT count(*) n FROM products WHERE active=1').get().n,collections:db.prepare('SELECT count(*) n FROM collections WHERE deleted_at IS NULL').get().n}));
db.close();
