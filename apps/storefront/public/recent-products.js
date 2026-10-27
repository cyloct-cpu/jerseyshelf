import {historyStore,HISTORY_KEY} from '/assets/recent-products-contract.js';
const section=document.querySelector('#recent-products');
if(section){
  // Accessing localStorage itself can throw, before getItem is called.
  let storage;try{storage=window.localStorage;}catch{storage=null;}
  const history=historyStore(storage,{capacity:Number(section.dataset.capacity),days:Number(section.dataset.days)});
  const grid=section.querySelector('#recent-products-grid');
  let request;
  async function render(rows){
    request?.abort();request=new AbortController();
    if(!rows.length){grid.replaceChildren();section.hidden=true;return;}
    try{
      const query=new URLSearchParams({ids:rows.map(row=>row.productId).join(','),lang:document.documentElement.lang});
      const response=await fetch('/api/products/recent?'+query,{signal:request.signal,credentials:'same-origin'});
      if(!response.ok)throw new Error('History unavailable');
      const result=await response.json();grid.innerHTML=result.html;section.hidden=!result.ids.length;
    }catch(err){if(err.name!=='AbortError'){section.hidden=true;grid.replaceChildren();}}
  }
  let entered=false;
  function enter(){if(!entered&&document.visibilityState==='visible'){entered=true;render(history.visit(Number(section.dataset.productId)));}}
  enter();document.addEventListener('visibilitychange',enter);
  window.addEventListener('pageshow',event=>{if(event.persisted){entered=false;enter();}});
  window.addEventListener('storage',event=>{if(event.key===HISTORY_KEY||event.key===null)render(history.read());});
  section.querySelector('#clear-recent-products')?.addEventListener('click',()=>render(history.clear()));
}
