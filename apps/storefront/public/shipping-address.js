(()=>{
 const section=document.querySelector('[data-shipping-address]');if(!section)return;
 const form=section.closest('form'),country=form.elements.country,region=form.elements.region,city=form.elements.city,postal=form.elements.postal,remember=form.elements.save_address,clear=section.querySelector('[data-clear-shipping-address]'),status=section.querySelector('[data-address-status]');
 const keys=['name','country','address','address2','region','city','postal','phone'],storageKey='ballworld.shipping-address.v1',guest=section.dataset.addressOwner==='guest',retry=section.dataset.addressRetry==='1';
 const message=key=>section.dataset[key],notice=text=>{status.textContent=text;status.hidden=!text;},norm=s=>String(s||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().trim();
 let locations={regions:[],cities:[]},previousCountry=country.value,previousRegion=norm(region.value),requestId=0,controller,loading=false;
 const matchRegion=()=>locations.regions.find(r=>[r.name,r.ascii,r.code].some(v=>norm(v)===norm(region.value)));
 const pickers=[];
 function locationPicker(input){
  const field=input.closest('.checkout-field'),toggle=field.querySelector('[data-location-toggle]'),panel=field.querySelector('[data-location-panel]'),list=panel.querySelector('ul'),empty=panel.querySelector('[role="status"]');
  let visible=[],active=-1,filter=true;
  function mark(index,scroll=false){
   active=index;Array.from(list.children).forEach((item,i)=>item.classList.toggle('is-active',i===active));
   const item=list.children[active];if(item){input.setAttribute('aria-activedescendant',item.id);if(scroll)item.scrollIntoView({block:'nearest'});}else input.removeAttribute('aria-activedescendant');
  }
  function render(){
   const match=matchRegion(),term=filter?norm(input.value):'';
   const candidates=input===region?locations.regions:locations.cities.filter(c=>!match||c.region===match.code);
   visible=candidates.filter(row=>!term||[row.name,row.ascii,input===region?row.code:''].some(v=>norm(v).includes(term))).slice(0,500);
   list.replaceChildren();for(const [i,row]of visible.entries()){
    const item=document.createElement('li');item.id='checkout-'+input.name+'-option-'+i;item.role='option';item.textContent=row.name;item.setAttribute('aria-selected',String(norm(input.value)===norm(row.name)));
    item.addEventListener('mousedown',event=>event.preventDefault());item.addEventListener('click',()=>choose(row.name));list.append(item);
   }
   empty.hidden=visible.length>0;empty.textContent=message(loading?'locationLoading':'locationEmpty');mark(visible.findIndex(row=>norm(row.name)===norm(input.value)));
  }
  function close(){panel.hidden=true;field.classList.remove('is-open');input.setAttribute('aria-expanded','false');toggle.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;}
  function open(all=false){pickers.forEach(p=>p.close());filter=!all;panel.hidden=false;field.classList.add('is-open');input.setAttribute('aria-expanded','true');toggle.setAttribute('aria-expanded','true');render();}
  function choose(value){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));close();input.focus();}
  toggle.hidden=false;
  toggle.addEventListener('click',()=>{if(panel.hidden){open(true);input.focus();}else{close();input.focus();}});
  input.addEventListener('click',()=>{if(panel.hidden)open(true);});
  input.addEventListener('input',()=>open());
  input.addEventListener('keydown',event=>{
   if(event.isComposing)return;
   if(['ArrowDown','ArrowUp'].includes(event.key)){
    event.preventDefault();if(panel.hidden)open(true);if(visible.length)mark(active<0?(event.key==='ArrowDown'?0:visible.length-1):(active+(event.key==='ArrowDown'?1:-1)+visible.length)%visible.length,true);
   }else if(event.key==='Enter'&&!panel.hidden){event.preventDefault();if(visible.length)choose(visible[Math.max(0,active)].name);else close();}
   else if(event.key==='Escape'&&!panel.hidden){event.preventDefault();close();}
   else if(event.key==='Tab')close();
  });
  field.addEventListener('focusout',event=>{if(!field.contains(event.relatedTarget))close();});
  document.addEventListener('click',event=>{if(!field.contains(event.target))close();});
  return {close,refresh:()=>{if(!panel.hidden)render();}};
 }
 function regionChanged(){
  if(norm(region.value)!==previousRegion){city.value='';pickers[1]?.close();}
  previousRegion=norm(region.value);pickers[1]?.refresh();
 }
 region.addEventListener('input',regionChanged);
 region.addEventListener('change',()=>{const match=matchRegion();if(match)region.value=match.name;regionChanged();});
 pickers.push(locationPicker(region),locationPicker(city));
 function hints(){for(const input of [region,postal]){const field=input.closest('.checkout-field');field.querySelector('[data-required]').hidden=!input.required;field.querySelector('[data-optional]').hidden=input.required;}}
 async function loadLocations(reset=false){
  if(reset&&country.value!==previousCountry){region.value='';city.value='';postal.value='';pickers.forEach(p=>p.close());
   for(const input of [region,city,postal]){input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');input.closest('.checkout-field').querySelector('.field-error')?.remove();}
  }
  previousCountry=country.value;previousRegion=norm(region.value);hints();controller?.abort();const id=++requestId;locations={regions:[],cities:[]};loading=!!country.value;pickers.forEach(p=>p.refresh());
  if(!country.value)return;controller=new AbortController();
  try{const response=await fetch('/api/address/locations?country='+encodeURIComponent(country.value),{signal:controller.signal,credentials:'same-origin'});if(!response.ok)throw Error();const data=await response.json();if(id!==requestId)return;locations=data;}catch{ /* Suggestions are optional; manual entry always remains available. */ }
  finally{if(id===requestId){loading=false;pickers.forEach(p=>p.refresh());}}
 }
 country.addEventListener('change',()=>loadLocations(true));
 if(guest&&!retry){try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved&&Date.now()-saved.at<90*86400000&&Array.from(country.options).some(o=>o.value===saved.address?.country)){
   for(const key of keys){const input=form.elements[key],value=saved.address[key];if(typeof value==='string'&&value.length<=(input.maxLength>0?input.maxLength:500))input.value=value;}
   remember.checked=true;clear.hidden=false;previousCountry=country.value;country.dispatchEvent(new Event('change',{bubbles:true}));
  }else if(saved)localStorage.removeItem(storageKey);}catch{}}
 loadLocations();
 form.addEventListener('submit',()=>{
  if(!guest)return;
  try{if(remember.checked){const address=Object.fromEntries(keys.map(k=>[k,form.elements[k].value]));localStorage.setItem(storageKey,JSON.stringify({at:Date.now(),address}));}else localStorage.removeItem(storageKey);}catch{notice(message('storageError'));}
 });
 clear.addEventListener('click',async()=>{
  clear.disabled=true;
  try{if(guest)localStorage.removeItem(storageKey);else{const r=await fetch('/account/shipping-address/clear',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:form.elements.csrf.value}),credentials:'same-origin'});if(!r.ok)throw Error();}
   remember.checked=false;clear.hidden=true;notice(message('cleared'));
  }catch{notice(message('clearError'));}finally{clear.disabled=false;}
 });
 form.addEventListener('invalid',event=>{
  const input=event.target;if(!section.contains(input))return;
  input.setAttribute('aria-invalid','true');const field=input.closest('.checkout-field');if(!field)return;
  let error=field.querySelector('.field-error');if(!error){error=document.createElement('p');error.className='field-error';error.id='error-'+input.name;field.append(error);}
  error.textContent=input.name==='phone'?message(input.validity.valueMissing?'phoneEmpty':'phoneError'):message('requiredError');input.setAttribute('aria-describedby',error.id);
 },true);
 for(const key of keys){const input=form.elements[key];const clearError=()=>{if(input.validity.valid){input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');input.closest('.checkout-field')?.querySelector('.field-error')?.remove();}};input.addEventListener('input',clearError);input.addEventListener('change',clearError);}
})();
