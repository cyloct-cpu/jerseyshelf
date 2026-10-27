// Display-only simulation. These values must never be sent to traffic analytics.
export const HEAT_CONFIG=Object.freeze({min:200,max:1000,minStep:3,maxStep:15,minDelay:8000,maxDelay:15000,ttl:30*60*1000});
export const HEAT_KIND='simulated-product-heat-v1';
export const heatStorageKey=id=>'bw_product_heat_demo_v1:'+id;
const validValue=value=>Number.isInteger(value)&&value>=HEAT_CONFIG.min&&value<=HEAT_CONFIG.max;
function randomInt(min,max,random){return min+Math.floor(Math.max(0,Math.min(1-Number.EPSILON,random()))*(max-min+1));}
export function initialHeat(random=Math.random){return randomInt(HEAT_CONFIG.min,HEAT_CONFIG.max,random);}
export function heatDelay(random=Math.random){return randomInt(HEAT_CONFIG.minDelay,HEAT_CONFIG.maxDelay,random);}
export function nextHeat(value,random=Math.random){
  if(!validValue(value))return initialHeat(random);
  const step=randomInt(HEAT_CONFIG.minStep,HEAT_CONFIG.maxStep,random),direction=random()<0.5?-1:1;
  const next=value+direction*step;
  return next<HEAT_CONFIG.min||next>HEAT_CONFIG.max?value-direction*step:next;
}
export function readHeat(storage,id,now=Date.now()){
  try{
    const item=JSON.parse(storage.getItem(heatStorageKey(id)));
    return item?.kind===HEAT_KIND&&validValue(item.value)&&Number.isSafeInteger(item.updatedAt)&&item.updatedAt<=now&&now-item.updatedAt<HEAT_CONFIG.ttl?item.value:null;
  }catch{return null;}
}
export function writeHeat(storage,id,value,now=Date.now()){
  if(!validValue(value))return;
  try{storage.setItem(heatStorageKey(id),JSON.stringify({kind:HEAT_KIND,value,updatedAt:now}));}catch{}
}
export function createHeatController({initialValue,render,save=()=>{},visible=()=>true,random=Math.random,schedule=setTimeout,cancel=clearTimeout}){
  let value=validValue(initialValue)?initialValue:initialHeat(random),timer=null,active=false,disposed=false;
  const publish=()=>{render(value);save(value);};
  function queue(){if(active&&!disposed&&visible()&&timer===null)timer=schedule(tick,heatDelay(random));}
  function tick(){timer=null;if(!active||disposed||!visible())return;value=nextHeat(value,random);publish();queue();}
  function pause(){active=false;if(timer!==null){cancel(timer);timer=null;}}
  publish();
  return {
    resume(){if(disposed)return;active=true;queue();},
    pause,
    destroy(){pause();disposed=true;}
  };
}
