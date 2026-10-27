import {readHeat,writeHeat,createHeatController} from '/assets/product-heat-contract.js';
const element=document.querySelector('[data-product-heat]');
if(element){
  const number=element.querySelector('[data-product-heat-value]'),id=element.dataset.productId;
  let storage;try{storage=window.sessionStorage;}catch{storage=null;}
  const controller=createHeatController({
    initialValue:readHeat(storage,id),
    render(value){number.textContent=String(value);element.hidden=false;},
    save:value=>writeHeat(storage,id,value),
    visible:()=>!document.hidden
  });
  document.addEventListener('visibilitychange',()=>document.hidden?controller.pause():controller.resume());
  window.addEventListener('pagehide',event=>event.persisted?controller.pause():controller.destroy());
  window.addEventListener('pageshow',()=>controller.resume());
  controller.resume();
}
