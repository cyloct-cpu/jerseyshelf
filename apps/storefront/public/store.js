// Open the chat as a navigation, separate from the protected form submission.
// This also avoids forwarding a POST through WhatsApp's external redirects.
document.addEventListener('submit',async event=>{
  const form=event.target,button=event.submitter;
  const action=new URL(button?.getAttribute('formaction')||form.action,location.href);
  if(action.origin!==location.origin||!(/^\/contact\/whatsapp$|^\/orders\/BW-[A-Z0-9-]+\/whatsapp$/).test(action.pathname))return;
  event.preventDefault();
  if(form.dataset.whatsappPending)return;
  const popup=window.open('about:blank','_blank');
  if(popup)popup.opener=null;
  form.dataset.whatsappPending='1';
  try{
    const response=await fetch(action.pathname,{method:'POST',credentials:'same-origin',headers:{Accept:'application/json'},body:new URLSearchParams(new FormData(form)),signal:AbortSignal.timeout(20000)});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'WhatsApp unavailable');
    const destination=new URL(result.url);
    if(destination.origin!=='https://wa.me')throw new Error('Invalid WhatsApp link');
    if(popup&&!popup.closed)popup.location.replace(destination.href);
    else location.assign(destination.href);
  }catch(error){
    popup?.close();
    window.alert(error.message);
  }finally{delete form.dataset.whatsappPending;}
});
const slides=[...document.querySelectorAll('.hero .slide')];let index=0,slideTimer;
function show(i){if(!slides.length)return;index=(i+slides.length)%slides.length;slides.forEach((s,n)=>s.classList.toggle('current',n===index));document.querySelector('#slide-count').textContent=`${index+1} / ${slides.length}`;}
function startAutoSlide(){clearInterval(slideTimer);if(slides.length>1)slideTimer=setInterval(()=>show(index+1),10000);}
document.querySelectorAll('[data-slide]').forEach(b=>b.addEventListener('click',()=>{show(index+(b.dataset.slide==='next'?1:-1));startAutoSlide();}));
startAutoSlide();
document.querySelectorAll('[data-gallery]').forEach(b=>b.addEventListener('click',()=>{const img=document.querySelector('#main-image img');if(img)img.src=b.dataset.gallery;}));
const purchase=document.querySelector('[data-purchase-form]');
if(purchase){
  const quantity=purchase.querySelector('[name="quantity"]'),button=purchase.querySelector('[data-add-cart]'),buyButton=purchase.querySelector('[data-buy-now]'),note=purchase.querySelector('[data-stock-note]');
  function updatePurchase(){
    const selected=purchase.querySelector('[name="variantId"]:checked');if(!selected)return;
    const printing=purchase.querySelector('[name="printingName"]'),extra=(printing?.value.trim()?Number(printing.dataset.printingPrice):0)+[...purchase.querySelectorAll('[name="patchIds"]:checked')].reduce((sum,p)=>sum+Number(p.dataset.price),0);
    document.querySelector('.prices.large strong').textContent=displayCurrencyPrice(Number(selected.dataset.price)+extra);
    purchase.querySelector('[data-selected-size]').textContent=selected.dataset.label;
    const fee=purchase.querySelector('[data-customization-fee]');if(fee)fee.textContent=purchase.dataset.feeLabel+'：'+displayCurrencyPrice(extra)+' / '+purchase.dataset.unitLabel;
    const enough=Number.isInteger(Number(quantity.value))&&Number(quantity.value)>=1&&Number(quantity.value)<=99&&Number(selected.dataset.stock)>=Number(quantity.value);
    button.disabled=!enough;button.textContent=enough?purchase.dataset.readyLabel:Number(selected.dataset.stock)===0?purchase.dataset.emptyLabel:purchase.dataset.stockLabel;
    buyButton.disabled=!enough;buyButton.textContent=purchase.dataset.buyLabel;
    note.hidden=enough;note.textContent=button.disabled?button.textContent:'';
    purchase.querySelector('[data-quantity-step="-1"]').disabled=Number(quantity.value)<=1;
    purchase.querySelector('[data-quantity-step="1"]').disabled=Number(quantity.value)>=99;
  }
  purchase.addEventListener('submit',event=>{const submitter=event.submitter;if(!submitter||submitter.disabled||submitter.hasAttribute('data-whatsapp-contact'))return;queueMicrotask(()=>{button.disabled=true;buyButton.disabled=true;submitter.textContent=purchase.dataset.busyLabel;});});
  window.addEventListener('pageshow',updatePurchase);
  purchase.addEventListener('input',updatePurchase);purchase.addEventListener('change',updatePurchase);
  purchase.querySelectorAll('[data-quantity-step]').forEach(b=>b.addEventListener('click',()=>{quantity.value=Math.min(99,Math.max(1,(Math.trunc(Number(quantity.value))||1)+Number(b.dataset.quantityStep)));updatePurchase();}));updatePurchase();
}
const teamMenus=[...document.querySelectorAll('[data-team-menu]')];
for(const menu of teamMenus){
  menu.addEventListener('toggle',()=>{if(menu.open)for(const other of teamMenus)if(other!==menu)other.open=false;});
  menu.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse'&&matchMedia('(hover:hover)').matches){for(const other of teamMenus)other.open=false;menu.open=true;}});
}
document.querySelector('.nav')?.addEventListener('pointerleave',event=>{if(event.pointerType==='mouse')for(const menu of teamMenus)menu.open=false;});
document.addEventListener('click',event=>{if(!event.target.closest('.team-menu'))for(const menu of teamMenus)menu.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){const active=teamMenus.find(menu=>menu.open);for(const menu of teamMenus)menu.open=false;active?.querySelector('summary').focus();}});
const languageMenu=document.querySelector('.language-menu');
const languageSearch=languageMenu?.querySelector('.language-search');
if(languageSearch){
  const options=[...languageMenu.querySelectorAll('[data-language-option]')],empty=languageMenu.querySelector('.language-search-empty');
  const normalize=value=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().trim();
  function filterLanguages(){const query=normalize(languageSearch.value);let matches=0;for(const option of options){option.hidden=!normalize(option.dataset.languageOption).includes(query);if(!option.hidden)matches++;}empty.hidden=matches>0;}
  languageSearch.addEventListener('input',filterLanguages);
  languageMenu.addEventListener('toggle',()=>{if(!languageMenu.open){languageSearch.value='';filterLanguages();}});
}
document.addEventListener('click',event=>{if(languageMenu&&!event.target.closest('.language-menu'))languageMenu.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&languageMenu?.open){languageMenu.open=false;languageMenu.querySelector('summary').focus();}});
const currencyMenu=document.querySelector('.currency-menu');
document.querySelector('.currency-search')?.addEventListener('input',event=>{const q=event.target.value.trim().toLowerCase();document.querySelectorAll('[data-currency-option]').forEach(option=>{option.hidden=!option.dataset.currencyOption.toLowerCase().includes(q);});});
document.addEventListener('click',event=>{if(currencyMenu&&!event.target.closest('.currency-menu'))currencyMenu.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&currencyMenu?.open){currencyMenu.open=false;currencyMenu.querySelector('summary').focus();}});
function displayCurrencyPrice(usdMinor){
  const code=document.body.dataset.currency||'USD',minor=Number(document.body.dataset.currencyMinor||2),rate=Number(document.body.dataset.fxRate||1),locale=document.body.dataset.locale||'zh-CN';
  const [whole,fraction='']=rate.toFixed(12).split('.'),denominator=100n*10n**BigInt(fraction.length),scaled=BigInt(Math.round(usdMinor))*BigInt(whole+fraction)*10n**BigInt(minor),amount=Number((scaled+denominator/2n)/denominator)/10**minor;
  return code==='USD'?'$'+amount.toFixed(2):new Intl.NumberFormat(locale,{style:'currency',currency:code,currencyDisplay:'code',minimumFractionDigits:minor,maximumFractionDigits:minor}).format(amount);
}

// Register visible storefront pages; one document contributes one page view.
(()=>{
  const path=document.querySelector('meta[name="traffic-path"]')?.content,csrf=document.querySelector('meta[name="traffic-csrf"]')?.content;
  if(!path||!csrf)return;
  const pageId=crypto.randomUUID();let registered=false,pending=false,stopped=false;
  const count=document.querySelector('[data-live-viewer-count]');
  const payload=action=>new URLSearchParams({csrf,pageId,path,action});
  async function heartbeat(){
    if(document.hidden||pending||stopped)return;pending=true;
    try{
      const response=await fetch('/api/traffic',{method:'POST',body:payload(registered?'heartbeat':'enter'),credentials:'same-origin'});
      if(!response.ok)throw new Error('Traffic unavailable');
      const stats=await response.json();registered=true;if(count){count.textContent=String(stats.productOnline);count.removeAttribute('title');}
    }catch{if(count){count.textContent='—';count.title='实时人数暂不可用';}}finally{pending=false;}
  }
  function leave(){if(registered)navigator.sendBeacon('/api/traffic',payload('leave'));}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)leave();else heartbeat();});
  window.addEventListener('pagehide',()=>{stopped=true;leave();});
  window.addEventListener('pageshow',()=>{stopped=false;heartbeat();});
  setInterval(heartbeat,15000);heartbeat();
})();

// Checkout form progressively enhances native validation; server validation is authoritative.
document.querySelectorAll('[data-country-picker]').forEach(picker=>{
  const select=picker.querySelector('select'),trigger=picker.querySelector('[data-country-trigger]'),panel=picker.querySelector('[data-country-panel]'),search=picker.querySelector('[data-country-search]'),list=picker.querySelector('[data-country-options]'),empty=picker.querySelector('[data-country-empty]'),label=picker.querySelector('[data-country-label]');
  const normalize=text=>text.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase().trim();
  const options=Array.from(select.options).filter(option=>option.value).map(option=>({code:option.value,label:option.textContent,search:normalize(option.dataset.search||option.textContent)}));
  let visible=[],active=-1;
  function markActive(index){
    active=index;
    Array.from(list.children).forEach((option,i)=>option.classList.toggle('is-active',i===active));
    const item=list.children[active];
    if(item){search.setAttribute('aria-activedescendant',item.id);item.scrollIntoView({block:'nearest'});}else search.removeAttribute('aria-activedescendant');
  }
  function render(){
    const term=normalize(search.value),exact=options.find(option=>option.code.toLowerCase()===term);
    visible=exact?[exact]:options.filter(option=>!term||option.search.includes(term));
    list.replaceChildren();
    for(const option of visible){
      const item=document.createElement('li');item.id='checkout-country-option-'+option.code;item.role='option';item.tabIndex=-1;item.dataset.code=option.code;item.textContent=option.label;item.setAttribute('aria-selected',String(select.value===option.code));
      item.addEventListener('click',()=>choose(option.code));list.append(item);
    }
    empty.hidden=visible.length>0;markActive(visible.length?Math.max(0,visible.findIndex(option=>option.code===select.value)):-1);
  }
  function sync(){label.textContent=select.selectedOptions[0]?.textContent||select.options[0].textContent;if(select.value){trigger.removeAttribute('aria-invalid');select.removeAttribute('aria-invalid');}if(!panel.hidden)render();}
  function close(restoreFocus=false){panel.hidden=true;trigger.setAttribute('aria-expanded','false');search.removeAttribute('aria-activedescendant');if(restoreFocus)trigger.focus();}
  function open(){panel.hidden=false;trigger.setAttribute('aria-expanded','true');search.value='';render();search.focus();}
  function choose(code){select.value=code;select.dispatchEvent(new Event('change',{bubbles:true}));close(true);}
  trigger.addEventListener('click',()=>panel.hidden?open():close());
  trigger.addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();open();if(event.key==='ArrowUp')markActive(visible.length-1);}});
  search.addEventListener('input',render);
  search.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(visible.length)markActive((active+(event.key==='ArrowDown'?1:-1)+visible.length)%visible.length);}
    else if(event.key==='Enter'){event.preventDefault();if(visible[active])choose(visible[active].code);}
    else if(event.key==='Escape'){event.preventDefault();close(true);}
  });
  picker.addEventListener('focusout',event=>{if(!picker.contains(event.relatedTarget))close();});
  document.addEventListener('click',event=>{if(!picker.contains(event.target))close();});
  document.querySelector('label[for="checkout-country"]')?.setAttribute('for',trigger.id);
  select.addEventListener('change',sync);
  select.addEventListener('invalid',event=>{event.preventDefault();trigger.setAttribute('aria-invalid','true');open();});
  select.form?.addEventListener('reset',()=>setTimeout(()=>{sync();close();},0));
  sync();trigger.hidden=false;select.hidden=true;
});

const checkoutForm=document.querySelector('[data-checkout-form]');
if(checkoutForm){
  const country=checkoutForm.querySelector('[name="country"]'),postal=checkoutForm.querySelector('[name="postal"]'),submit=checkoutForm.querySelector('[data-checkout-submit]'),ready=submit.textContent,originalDisabled=submit.disabled;
  const postalCountries=(document.body.dataset.postalRequired||'').split(' ');
  function updatePostal(){postal.required=postalCountries.includes(country.value);const mark=checkoutForm.querySelector('label[for="checkout-postal"] span');if(mark)mark.hidden=!postal.required;}
  country.addEventListener('change',updatePostal);updatePostal();
  const region=checkoutForm.querySelector('[name="region"]');if(region){const updateRegion=()=>{region.required=(document.body.dataset.regionRequired||'').split(' ').includes(country.value);region.closest('.checkout-field').querySelector('label span').hidden=!region.required;};country.addEventListener('change',updateRegion);updateRegion();}
  const summary=document.querySelector('[data-checkout-summary]');if(matchMedia('(max-width:700px)').matches)summary.open=false;
  document.querySelector('.checkout-error')?.focus();
  checkoutForm.addEventListener('submit',()=>{submit.disabled=true;submit.textContent=submit.dataset.busyLabel;});
  window.addEventListener('pageshow',()=>{submit.disabled=originalDisabled;submit.textContent=ready;});
}

// Copy tracking numbers without exposing order details in client data.
document.querySelectorAll('[data-copy-tracking]').forEach(button=>button.addEventListener('click',async()=>{
  const status=button.closest('article').querySelector('.tracking-copy-status');
  try{await navigator.clipboard.writeText(button.dataset.copyTracking);status.textContent=document.documentElement.lang==='zh-CN'?'已复制':'Copied';}
  catch{status.textContent=document.documentElement.lang==='zh-CN'?'复制失败，请手动选择运单号复制':'Please select and copy the tracking number manually';}
}));

// Keep the floating contact control clear of buying and order-contact actions.
const waFloating=document.querySelector('.whatsapp-floating');
if(waFloating){
  const key='jerseyshelf.whatsapp-position.v1';
  let saved=null,gesture=null,suppressClick=false;
  try{const value=JSON.parse(localStorage.getItem(key));if(['left','right'].includes(value?.side)&&Number.isFinite(value.ratio))saved={side:value.side,ratio:Math.max(0,Math.min(1,value.ratio))};}catch{}
  const bounds=()=>{
    const viewport=window.visualViewport,margin=innerWidth<=700?14:22;
    const left=(viewport?.offsetLeft||0)+margin,top=(viewport?.offsetTop||0)+margin;
    return {left,top,right:Math.max(left,left+(viewport?.width||innerWidth)-waFloating.offsetWidth-2*margin),bottom:Math.max(top,top+(viewport?.height||innerHeight)-waFloating.offsetHeight-2*margin)};
  };
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  function place(x,y){
    const b=bounds();
    waFloating.style.left=clamp(x,b.left,b.right)+'px';waFloating.style.top=clamp(y,b.top,b.bottom)+'px';
    waFloating.style.right='auto';waFloating.style.bottom='auto';
  }
  function restore(){
    if(gesture||!waFloating.offsetWidth)return;
    const b=bounds();
    place(saved?.side==='left'?b.left:b.right,saved?b.top+saved.ratio*(b.bottom-b.top):b.bottom);
  }
  function settle(){
    const b=bounds(),rect=waFloating.getBoundingClientRect();
    saved={side:rect.left-b.left<(b.right-b.left)/2?'left':'right',ratio:b.bottom===b.top?0:clamp((rect.top-b.top)/(b.bottom-b.top),0,1)};
    place(saved.side==='left'?b.left:b.right,b.top+saved.ratio*(b.bottom-b.top));
    try{localStorage.setItem(key,JSON.stringify(saved));}catch{}
  }
  waFloating.addEventListener('pointerdown',event=>{
    if(!event.isPrimary||event.button!==0||gesture)return;
    suppressClick=false;
    const rect=waFloating.getBoundingClientRect();
    const capture=event.target.closest('a,button')||waFloating;
    gesture={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top,dragging:false,capture};
    capture.setPointerCapture(event.pointerId);
  });
  waFloating.addEventListener('pointermove',event=>{
    if(gesture?.id!==event.pointerId)return;
    const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;
    if(!gesture.dragging&&Math.hypot(dx,dy)<8)return;
    if(!gesture.dragging){gesture.dragging=true;waFloating.classList.add('is-dragging');}
    event.preventDefault();place(gesture.left+dx,gesture.top+dy);
  });
  function finish(event){
    if(gesture?.id!==event.pointerId)return;
    const dragged=gesture.dragging,capture=gesture.capture;gesture=null;
    waFloating.classList.remove('is-dragging');
    if(dragged){suppressClick=true;settle();}
    if(capture.hasPointerCapture(event.pointerId))capture.releasePointerCapture(event.pointerId);
  }
  waFloating.addEventListener('pointerup',finish);
  waFloating.addEventListener('pointercancel',finish);
  waFloating.addEventListener('lostpointercapture',finish);
  waFloating.addEventListener('click',event=>{if(suppressClick&&event.detail!==0){event.preventDefault();event.stopImmediatePropagation();suppressClick=false;}},true);
  waFloating.addEventListener('dragstart',event=>event.preventDefault());
  window.addEventListener('resize',restore);
  window.addEventListener('pageshow',restore);
  window.visualViewport?.addEventListener('resize',restore);
  window.visualViewport?.addEventListener('scroll',restore);
  if('ResizeObserver' in window)new ResizeObserver(restore).observe(waFloating);
  restore();
}
if(waFloating&&'IntersectionObserver' in window){
  const visibleActions=new Set();
  const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting)visibleActions.add(entry.target);else visibleActions.delete(entry.target);}waFloating.hidden=visibleActions.size>0;});
  document.querySelectorAll('.purchase-actions,.cart-summary,.whatsapp-contact,[data-registration-form] > .button,[data-account-contact-form] > .button').forEach(el=>observer.observe(el));
}

// Registration uses native validation plus server validation; never persist passwords.
document.querySelectorAll('[data-toggle-password]').forEach(button=>button.addEventListener('click',()=>{const input=document.getElementById(button.getAttribute('aria-controls')),show=input.type==='password';input.type=show?'text':'password';button.textContent=show?button.dataset.hideLabel:button.dataset.showLabel;button.setAttribute('aria-pressed',String(show));}));
const accountMenu=document.querySelector('.account-menu');document.addEventListener('click',event=>{if(accountMenu&&!event.target.closest('.account-menu'))accountMenu.open=false;});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&accountMenu?.open){accountMenu.open=false;accountMenu.querySelector('summary').focus();}});

const accountContactForm=document.querySelector('[data-account-contact-form]');
if(accountContactForm){const consent=accountContactForm.querySelector('[name="whatsapp_consent"]');accountContactForm.querySelectorAll('[name="whatsapp_phone"],[name="whatsapp_country_code"]').forEach(input=>input.addEventListener('input',()=>{consent.checked=false;}));}
