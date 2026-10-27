import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHistory,recordRecent,historyStore,HISTORY_KEY} from '../packages/contracts/recent-products.mjs';
import {productProfile,profileSimilarity} from '../packages/contracts/product-profile.mjs';
const now=1800000000000,options={capacity:30,days:30};
test('缺少细分类时识别球衣、训练服、风衣、童装和复古，优先同类',()=>{
  const jersey=productProfile('2026 拜仁客场球衣','bayern-away-kit');
  assert.equal(jersey.kind,'jersey');assert.equal(productProfile('','paris-water-repellent-training-windbreaker').kind,'jacket');
  assert.equal(productProfile('','bayern-long-sleeve-sweatshirt').kind,'sweatshirt');assert.equal(productProfile('训练服','').kind,'training');
  assert.ok(productProfile('复古儿童球衣','').kids);assert.ok(productProfile('复古儿童球衣','').retro);
  assert.ok(profileSimilarity(jersey,productProfile('','bayern-home-jersey'))>profileSimilarity(jersey,productProfile('','bayern-sweatshirt')));
});
test('最近浏览 A→B→A 去重置顶，容量和期限裁剪，仅保留 ID/时间',()=>{
  let rows=recordRecent([],1,options,now);
  rows=recordRecent(rows,2,options,now+1);rows=recordRecent(rows,1,options,now+2);
  assert.deepEqual(rows.map(r=>r.productId),[1,2]);
  const many=Array.from({length:45},(_,i)=>({productId:i+1,viewedAt:now-i,price:200}));
  const clean=normalizeHistory(many,options,now);assert.equal(clean.length,30);assert.deepEqual(Object.keys(clean[0]),['productId','viewedAt']);
  assert.deepEqual(normalizeHistory([{productId:1,viewedAt:now-30*86400000},{productId:2,viewedAt:now-86400000}],options,now).map(r=>r.productId),[2]);
});
test('最近浏览拒绝损坏、非法 ID、未来时间，刷新不重复',()=>{
  for(const value of ['bad','{}','null',{},null])assert.deepEqual(normalizeHistory(value,options,now),[]);
  assert.deepEqual(normalizeHistory([{productId:'1',viewedAt:now},{productId:-1,viewedAt:now},{productId:2,viewedAt:now+300001},{productId:3,viewedAt:now,extra:'discard'}],options,now),[{productId:3,viewedAt:now}]);
  assert.equal(recordRecent(recordRecent([],1,options,now),1,options,now+1).length,1);
});
test('最近浏览存储被禁用时降级，清空不影响其它键',()=>{
  const denied={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){throw new Error('denied');}};
  const fallback=historyStore(denied,options);fallback.visit(1,now);fallback.visit(2,now+1);assert.deepEqual(fallback.read(now+2).map(r=>r.productId),[2,1]);fallback.clear();assert.deepEqual(fallback.read(now+3),[]);
  const quota=historyStore({getItem:()=>null,setItem(){throw new Error('quota');},removeItem(){throw new Error('denied');}},options);quota.visit(1,now);quota.visit(2,now+1);assert.deepEqual(quota.read(now+2).map(r=>r.productId),[2,1]);quota.clear();assert.deepEqual(quota.read(now+3),[]);
  const data=new Map([['cart','unchanged']]),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  const a=historyStore(storage,options),b=historyStore(storage,options);a.visit(1,now);assert.deepEqual(b.read(now),a.read(now));b.visit(2,now+1);assert.deepEqual(a.read(now+1).map(r=>r.productId),[2,1]);b.clear();assert.deepEqual(a.read(now+2),[]);assert.equal(data.get('cart'),'unchanged');assert.ok(!data.has(HISTORY_KEY));
});
