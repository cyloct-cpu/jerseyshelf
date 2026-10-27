import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HEAT_CONFIG,HEAT_KIND,initialHeat,nextHeat,heatDelay,readHeat,writeHeat,heatStorageKey,createHeatController} from '../packages/contracts/product-heat.mjs';
test('展示热度始终 200–1000，边界向内变化且每步 3–15',()=>{
  assert.equal(initialHeat(()=>0),200);assert.equal(initialHeat(()=>1),1000);
  assert.equal(heatDelay(()=>0),8000);assert.equal(heatDelay(()=>1),15000);
  for(let value=200;value<=1000;value++)for(const step of [0,0.5,1])for(const direction of [0,1]){
    let call=0;const next=nextHeat(value,()=>call++?direction:step);
    assert.ok(next>=200&&next<=1000,`${value} -> ${next}`);
    assert.ok(Math.abs(next-value)>=3&&Math.abs(next-value)<=15,`${value} -> ${next}`);
  }
});
test('展示状态按商品保存，30 分钟内刷新沿用，过期或损坏后重建',()=>{
  const now=1800000000000,data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  assert.equal(readHeat(storage,1,now),null);writeHeat(storage,1,528,now);writeHeat(storage,2,725,now);
  assert.equal(readHeat(storage,1,now+1),528);assert.equal(readHeat(storage,2,now+1),725);
  assert.equal(readHeat(storage,1,now+HEAT_CONFIG.ttl),null);
  assert.equal(JSON.parse(data.get(heatStorageKey(1))).kind,HEAT_KIND);
  for(const raw of ['broken','null','{}',JSON.stringify({kind:HEAT_KIND,value:1001,updatedAt:now}),JSON.stringify({kind:'online',value:528,updatedAt:now}),JSON.stringify({kind:HEAT_KIND,value:528,updatedAt:now+1})]){
    data.set(heatStorageKey(1),raw);assert.equal(readHeat(storage,1,now),null);
  }
});
test('限制存储和配额不足不阻止展示或刷新',()=>{
  const denied={getItem(){throw Error('blocked');},setItem(){throw Error('quota');}};
  assert.equal(readHeat(denied,1),null);assert.doesNotThrow(()=>writeHeat(denied,1,528));
  assert.equal(readHeat(null,1),null);assert.doesNotThrow(()=>writeHeat(null,1,528));
});
test('隐藏时暂停、可见时恢复，重复启动只有一个计时器，离开后停止',()=>{
  let visible=false,id=0;const pending=new Map(),rendered=[],saved=[];
  const controller=createHeatController({initialValue:528,render:value=>rendered.push(value),save:value=>saved.push(value),visible:()=>visible,random:()=>0,schedule:(fn,delay)=>{assert.ok(delay>=8000&&delay<=15000);pending.set(id,{fn,delay});return id++;},cancel:id=>pending.delete(id)});
  assert.deepEqual(rendered,[528]);controller.resume();assert.equal(pending.size,0);
  visible=true;controller.resume();controller.resume();assert.equal(pending.size,1);
  const tick=()=>{const [key,{fn}]=pending.entries().next().value;pending.delete(key);fn();};
  tick();assert.deepEqual(rendered,[528,525]);assert.equal(pending.size,1);
  controller.pause();assert.equal(pending.size,0);assert.equal(saved.length,2);
  visible=false;controller.resume();assert.equal(pending.size,0);
  visible=true;controller.resume();assert.equal(pending.size,1);
  // A visibility change before the callback cannot advance a hidden page.
  visible=false;tick();assert.deepEqual(rendered,[528,525]);assert.equal(pending.size,0);
  visible=true;controller.resume();tick();assert.deepEqual(rendered,[528,525,522]);
  controller.destroy();controller.resume();assert.equal(pending.size,0);
});
