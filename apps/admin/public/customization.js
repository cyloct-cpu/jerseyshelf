(()=>{
  const values=root=>Object.fromEntries([...root.querySelectorAll('[data-field]')].map(input=>[input.dataset.field,input.type==='checkbox'?input.checked:input.value]));
  const serialize=()=>({printing:values(document.querySelector('#printing-config')),patches:{...values(document.querySelector('#patches-config')),options:[...document.querySelectorAll('#patch-options-body .patch-option-row')].map(values)}});
  const globalForm=document.querySelector('#customization-template-form');
  if(globalForm)globalForm.addEventListener('submit',()=>{globalForm.querySelector('#customization-json').value=JSON.stringify(serialize());});
  const panel=document.querySelector('#product-customization');if(!panel)return;
  const mode=panel.querySelector('#customization-mode'),selector=panel.querySelector('#customization-template'),fields=panel.querySelector('#customization-overrides'),preview=panel.querySelector('#customization-inherited-preview');
  let hasDraft=panel.dataset.ownCustomization==='1';
  function selectedTemplate(){
    if(selector.value!=='auto')return selector.value;
    const kinds=[...document.querySelectorAll('#product-collections input:checked')].map(input=>input.dataset.collectionKind);
    return kinds.includes('national')&&!kinds.includes('club')?'national':'club';
  }
  function sync(){
    const inherited=mode.value==='inherit',key=selectedTemplate();
    if(!inherited&&!hasDraft){fields.replaceChildren(panel.querySelector('[data-template-fields="'+key+'"]').content.cloneNode(true));hasDraft=true;}
    fields.hidden=inherited;fields.disabled=inherited;preview.hidden=!inherited;
    panel.querySelectorAll('[data-template-preview]').forEach(el=>el.hidden=el.dataset.templatePreview!==key);
    selector.disabled=!inherited;
  }
  mode.addEventListener('change',sync);selector.addEventListener('change',sync);
  document.addEventListener('change',event=>{if(event.target.closest('#product-collections'))sync();});
  const categories=document.querySelector('#product-collections');if(categories)new MutationObserver(sync).observe(categories,{childList:true,subtree:true});
  sync();
})();
