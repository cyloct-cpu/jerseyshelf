const $ = s => document.querySelector(s);
if($('#product-image-editor')) initProductImages();
function initProductImages(){
  const roles=[['side','侧面图'],['size','尺寸图'],['detail','内部细节图'],['scene','参照场景图'],['unclassified','待分类']];
  const items=JSON.parse($('#image-initial-data').textContent).map(i=>({...i,key:crypto.randomUUID(),state:'ready'}));
  const list=$('#product-image-list'),status=$('#product-image-status'),form=$('#product-form');
  let uploadRole='detail',replaceKey=null,dragKey=null,media=[],selected=new Set();
  const el=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
  function normalize(){items.forEach((i,n)=>{if(n===0)i.role='main';else if(i.role==='main')i.role='detail';});}
  function button(text,action){const b=el('button',text);b.type='button';b.addEventListener('click',action);return b;}
  function move(key,to){const from=items.findIndex(i=>i.key===key);if(from<0||to<0||to>=items.length)return;items.splice(to,0,items.splice(from,1)[0]);render();}
  function preview(item){$('#product-image-preview-img').src=item.preview||item.path;$('#product-image-preview').showModal();}
  function render(){
    normalize();list.replaceChildren();
    $('#product-images').value=items.filter(i=>i.state==='ready').map(i=>i.path).join('\n');
    $('#product-image-roles').value=JSON.stringify(items.filter(i=>i.state==='ready').map(i=>i.role));
    $('#product-image-count').textContent='已添加 '+items.length+' 张 · 上传成功 '+items.filter(i=>i.state==='ready').length+' 张';
    items.forEach((item,index)=>{
      const card=el('article',null,'product-image-card');card.draggable=true;
      card.addEventListener('dragstart',event=>{dragKey=item.key;event.dataTransfer.setData('text/plain',item.key);event.dataTransfer.effectAllowed='move';});
      card.addEventListener('dragover',event=>event.preventDefault());
      card.addEventListener('drop',event=>{event.preventDefault();if(dragKey)move(dragKey,items.findIndex(i=>i.key===item.key));dragKey=null;});
      const thumb=button('',()=>preview(item));thumb.className='product-image-thumb';thumb.setAttribute('aria-label','预览 '+item.name);
      const img=el('img');img.src=item.preview||item.path;img.alt=item.name;thumb.append(img);card.append(thumb);
      card.append(el('span',index===0?'主图':roles.find(r=>r[0]===item.role)?.[1]||'待分类','image-card-role'),el('div',item.name,'image-card-name'));
      const state=el('p',item.state==='uploading'?'上传中…':item.state==='error'?item.error:'已就绪',item.state==='error'?'image-card-error':'image-card-status');state.setAttribute('role','status');card.append(state);
      if(index>0){const select=el('select');select.setAttribute('aria-label','图片分类');roles.forEach(([value,title])=>{const option=el('option',title);option.value=value;select.append(option);});select.value=item.role;select.addEventListener('change',()=>{item.role=select.value;render();});card.append(select);}
      const actions=el('div',null,'image-card-actions');
      if(index>0)actions.append(button('设为主图',()=>move(item.key,0)));
      const prev=button('前移',()=>move(item.key,index-1)),next=button('后移',()=>move(item.key,index+1));prev.disabled=index===0;next.disabled=index===items.length-1;actions.append(prev,next);
      if(item.state==='error')actions.append(button('重试',()=>upload(item,item.file)));
      const replace=button('替换',()=>{replaceKey=item.key;$('#replace-product-image').click();});replace.disabled=item.state==='uploading';actions.append(replace);
      actions.append(button('移除',()=>{const at=items.findIndex(i=>i.key===item.key);if(at>=0)items.splice(at,1);if(item.preview)URL.revokeObjectURL(item.preview);render();}));card.append(actions);list.append(card);
    });
  }
  function validate(file){
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))return '仅支持 JPG、PNG、WebP、GIF 图片';
    if(!file.size||file.size>3*1024*1024)return '请选择不超过 3 MB 的图片';
    return '';
  }
  async function upload(item,file,replacing=false){
    const error=validate(file);if(error){status.textContent=file.name+'：'+error;return;}
    item.state='uploading';item.error='';render();
    try{
      // Decode for a useful error on corrupt files; pixel dimensions and aspect ratio are unrestricted.
      const previewURL=URL.createObjectURL(file);
      try{await new Promise((resolve,reject)=>{const img=new Image();img.onload=resolve;img.onerror=()=>reject(new Error('图片无法读取，请更换有效图片'));img.src=previewURL;});}finally{URL.revokeObjectURL(previewURL);}
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file);});
      const response=await fetch('/admin/media/upload',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':form.elements.csrf.value},body:JSON.stringify({name:file.name,data,purpose:'product'})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'上传失败');
      item.path=result.path;item.name=file.name;item.state='ready';item.file=null;
      if(item.preview){URL.revokeObjectURL(item.preview);item.preview=null;}
      status.textContent='图片已上传，保存商品后生效。';
    }catch(err){
      if(replacing){item.state='ready';status.textContent='替换失败：'+err.message+'，原图片已保留。';}
      else{item.state='error';item.error=err.message;item.file=file;}
    }finally{render();}
  }
  async function addFiles(files,role){
    const rejected=[];
    const queue=[];
    for(const file of files){const error=validate(file);if(error){rejected.push(file.name+'：'+error);continue;}
      const item={key:crypto.randomUUID(),path:'',name:file.name,role,state:'uploading',preview:URL.createObjectURL(file),file};
      if(role==='main'){items.unshift(item);role='detail';}else items.push(item);queue.push(item);
    }
    render();for(const item of queue){if(items.includes(item))await upload(item,item.file);}
    if(rejected.length)status.textContent=rejected.join('；');
  }
  document.querySelectorAll('[data-upload-role]').forEach(b=>b.addEventListener('click',()=>{uploadRole=b.dataset.uploadRole;$('#product-image-files').click();}));
  $('#upload-product-images').addEventListener('click',()=>{uploadRole='detail';$('#product-image-files').click();});
  $('#product-image-files').addEventListener('change',event=>{const files=[...event.target.files];event.target.value='';addFiles(files,uploadRole);});
  $('#replace-product-image').addEventListener('change',event=>{const file=event.target.files[0],item=items.find(i=>i.key===replaceKey);event.target.value='';if(file&&item)upload(item,file,true);});
  form.addEventListener('submit',event=>{if(items.some(i=>i.state!=='ready')){event.preventDefault();$('#form-error').textContent='请等待图片上传完成，或重试、移除上传失败的图片。';}else $('#form-error').textContent='';});
  document.querySelectorAll('#product-image-editor [data-close-dialog]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  function renderMedia(){
    const target=$('#product-media-list'),q=$('#product-media-search').value.trim().toLowerCase();target.replaceChildren();
    for(const file of media.filter(i=>i.name.toLowerCase().includes(q))){
      const label=el('label',null,'media-picker-item'),checkbox=el('input');checkbox.type='checkbox';checkbox.checked=selected.has(file.id);checkbox.disabled=file.bytes>3*1024*1024;
      checkbox.addEventListener('change',()=>{if(checkbox.checked)selected.add(file.id);else selected.delete(file.id);$('#product-media-status').textContent='已选择 '+selected.size+' 张';});
      const img=el('img');img.src=file.path;img.alt=file.name;img.loading='lazy';label.append(checkbox,img,el('span',file.name),el('small',(file.bytes/1024/1024).toFixed(2)+' MB'+(checkbox.disabled?' · 超过3MB':'')));target.append(label);
    }
    if(!target.children.length)target.append(el('p','暂无匹配图片，请先本地上传。'));
  }
  $('#choose-product-media').addEventListener('click',async()=>{
    selected=new Set();$('#product-media-search').value='';$('#product-media-list').replaceChildren();$('#product-media-dialog').showModal();$('#product-media-status').textContent='读取中…';
    try{const response=await fetch('/admin/media.json');if(!response.ok)throw new Error('素材读取失败，请关闭后重试');media=await response.json();renderMedia();$('#product-media-status').textContent='可选择多张图片，每张不超过3MB。';}catch(err){$('#product-media-status').textContent=err.message;}
  });
  $('#product-media-search').addEventListener('input',renderMedia);
  $('#confirm-product-media').addEventListener('click',()=>{for(const file of media.filter(i=>selected.has(i.id)))items.push({key:crypto.randomUUID(),path:file.path,name:file.name,role:'detail',state:'ready'});render();$('#product-media-dialog').close();});
  window.addEventListener('beforeunload',event=>{if(items.some(i=>i.state==='uploading')){event.preventDefault();event.returnValue='';}});
  render();
}
function filterCollections(){const q=($('#collection-search')?.value||'').trim().toLowerCase();document.querySelectorAll('#product-collections [data-category]').forEach(el=>{el.hidden=!el.dataset.category.toLowerCase().includes(q);});document.querySelectorAll('[data-choice-group]').forEach(group=>{group.hidden=![...group.querySelectorAll('[data-category]')].some(el=>!el.hidden);});}
$('#collection-search')?.addEventListener('input',filterCollections);
$('#refresh-collections')?.addEventListener('click',async event=>{
  const button=event.target,selected=new Set([...document.querySelectorAll('#product-collections input:checked')].map(el=>Number(el.value)));button.disabled=true;
  try{const response=await fetch('/admin/collections.json');if(!response.ok)throw new Error('分类读取失败');const items=await response.json(),target=$('#product-collections');target.replaceChildren();
    const names={europe:'欧洲',america:'美洲',africa:'非洲',asia:'亚洲','serie-a':'意甲','premier-league':'英超联赛','ligue-1':'法甲联赛',bundesliga:'德甲','la-liga':'西甲','other-clubs':'其他俱乐部'},groups=new Map();
    for(const c of items){const key=c.kind+':'+(c.team_group||''),title=c.kind==='other'?'商品系列':(c.kind==='national'?'国家队 · ':'俱乐部 · ')+(names[c.team_group]||'未分组');
      if(!groups.has(key)){const section=document.createElement('section');section.className='collection-choice-group';section.dataset.choiceGroup='';const h=document.createElement('h3');h.textContent=title;const checks=document.createElement('div');checks.className='checks';section.append(h,checks);target.append(section);groups.set(key,checks);}
      const label=document.createElement('label');label.dataset.category=c.name+' '+c.slug+' '+title;const input=document.createElement('input');input.type='checkbox';input.name='collections';input.dataset.collectionKind=c.kind;input.value=c.id;input.checked=selected.has(c.id);label.append(input,document.createTextNode(c.name));groups.get(key).append(label);}filterCollections();button.textContent='已刷新';
  }catch(err){button.textContent=err.message;}finally{button.disabled=false;}
});
for(const [button,template,body] of [['add-variant','variant-template','variants-body'],['add-slide','slide-template','slides-body'],['add-section','section-template','sections-body']]){
  $('#'+button)?.addEventListener('click',()=>{const fragment=$('#'+template).content.cloneNode(true);if(button==='add-patch-option')fragment.querySelector('[data-field="id"]').value='patch-'+crypto.randomUUID();$('#'+body).append(fragment);});
}
document.addEventListener('click', async event=>{
  if(event.target.closest('#add-patch-option')){const fragment=$('#patch-option-template').content.cloneNode(true);fragment.querySelector('[data-field="id"]').value='patch-'+crypto.randomUUID();$('#patch-options-body').append(fragment);}
  if(event.target.matches('[data-remove-row]'))event.target.closest('.variant-row,.slide-row,.section-row,.patch-option-row').remove();
  if(event.target.matches('[data-copy]')){
    try{await navigator.clipboard.writeText(event.target.dataset.copy);event.target.textContent='已复制';}catch{event.target.parentElement.querySelector('input').select();event.target.textContent='请复制选中路径';}
  }
});
const collect = row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(el=>[el.dataset.field,el.type==='checkbox'?el.checked:el.value]));
$('#product-form')?.addEventListener('submit',event=>{
  const rows=[...document.querySelectorAll('.variant-row')].map(collect);
  if(!rows.length){event.preventDefault();$('#form-error').textContent='请至少保留一个规格';return;}
  $('#variants-json').value=JSON.stringify(rows);
  if($('#product-customization'))$('#customization-json').value=$('#customization-mode').value==='inherit'?'':JSON.stringify({printing:collect($('#printing-config')),patches:{...collect($('#patches-config')),options:[...document.querySelectorAll('.patch-option-row')].map(collect)}});
});
$('#home-form')?.addEventListener('submit',event=>{
  const slides=[...document.querySelectorAll('.slide-row')].map(collect),sections=[...document.querySelectorAll('.section-row')].map(collect);
  if(!slides.length){event.preventDefault();$('#form-error').textContent='请至少保留一张轮播';return;}
  const extraImages=[...document.querySelectorAll('.extra-image-row')].map(collect);
  $('#home-json').value=JSON.stringify({slides,sections,extraImages});
});
$('#upload-form')?.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target;const status=$('#upload-status');const file=form.file.files[0];
  if(!file||file.size>8*1024*1024){status.textContent='请选择不超过 8 MB 的图片';return;}
  const button=form.querySelector('button');button.disabled=true;status.textContent='上传中…';
  try{
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
    const response=await fetch('/admin/media/upload',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':form.csrf.value},body:JSON.stringify({name:file.name,data})});
    const result=await response.json();if(!response.ok)throw new Error(result.error);location.reload();
  }catch(err){status.textContent=err.message;button.disabled=false;}
});
async function importFile(dryRun){
  const form=$('#import-form'),out=$('#import-result'),file=form.file.files[0];
  try{
    if(!file||file.size>10*1024*1024)throw new Error('请选择不超过 10 MB 的 JSON 文件');
    const catalog=JSON.parse(await file.text());out.textContent='处理中…';
    const response=await fetch('/admin/import',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':form.csrf.value},body:JSON.stringify({catalog,dryRun,overwrite:form.overwrite.checked})});
    const result=await response.json();if(!response.ok)throw new Error(result.error);out.textContent=JSON.stringify(result,null,2);
  }catch(err){out.textContent=err.message;}
}
$('#import-preview')?.addEventListener('click',()=>importFile(true));
$('#import-form')?.addEventListener('submit',event=>{event.preventDefault();importFile(false);});
function syncCollectionTeamGroup(){
  const kind=document.querySelector('#collection-kind'),group=document.querySelector('#collection-team-group');if(!kind||!group)return;
  for(const option of group.querySelectorAll('[data-kind]')){option.hidden=option.dataset.kind!==kind.value;option.disabled=option.hidden;}
  if(group.selectedOptions[0]?.disabled)group.value='';group.disabled=kind.value==='other';
}
document.querySelector('#collection-kind')?.addEventListener('change',syncCollectionTeamGroup);syncCollectionTeamGroup();
const translationData=document.querySelector('#product-translations-json');
if(translationData){
  const content=JSON.parse(translationData.value),language=document.querySelector('#product-translation-language'),title=document.querySelector('#product-translation-title'),description=document.querySelector('#product-translation-description');let previous=language.value;
  function saveTranslation(){const value={title:title.value.trim(),description:description.value.trim()};if(value.title||value.description)content[previous]=value;else delete content[previous];translationData.value=JSON.stringify(content);document.querySelector('#product-translation-status').textContent='已填写 '+Object.keys(content).length+' 种语言，保存商品后生效。';}
  function loadTranslation(){title.value=content[language.value]?.title||'';description.value=content[language.value]?.description||'';previous=language.value;}
  language.addEventListener('change',()=>{saveTranslation();loadTranslation();});title.addEventListener('input',saveTranslation);description.addEventListener('input',saveTranslation);document.querySelector('#product-form').addEventListener('submit',saveTranslation);loadTranslation();
}

(()=>{
  const panels=[...document.querySelectorAll('[data-traffic-panel]')];if(!panels.length)return;
  let pending=false;
  async function refreshTraffic(){
    if(pending)return;pending=true;
    try{
      const response=await fetch('/admin/traffic.json',{credentials:'same-origin'});if(!response.ok)throw new Error('Stats unavailable');const stats=await response.json();
      for(const panel of panels){
        panel.querySelector('[data-traffic-day]').textContent=stats.day;
        panel.querySelectorAll('[data-traffic-metric]').forEach(el=>el.textContent=String(stats[el.dataset.trafficMetric]));
        const body=panel.querySelector('[data-traffic-products]');body.replaceChildren();
        for(const p of stats.products){const row=document.createElement('tr'),name=document.createElement('td'),link=document.createElement('a');link.href='/products/'+p.slug;link.target='_blank';link.textContent=p.title;name.append(link);row.append(name);for(const key of ['online','views','visitors']){const cell=document.createElement('td');cell.textContent=String(p[key]);row.append(cell);}body.append(row);}
        if(!stats.products.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;cell.textContent='暂无商品访问记录';row.append(cell);body.append(row);}
        panel.querySelector('[data-traffic-status]').textContent='最近更新：'+new Date(stats.updatedAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})+' · 显示今日访问最多的前 30 件商品';
      }
    }catch{panels.forEach(panel=>panel.querySelector('[data-traffic-status]').textContent='暂时无法更新统计，请稍后刷新。');}finally{pending=false;}
  }
  panels.forEach(panel=>panel.querySelector('[data-refresh-traffic]').addEventListener('click',refreshTraffic));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshTraffic();});setInterval(()=>{if(!document.hidden)refreshTraffic();},10000);
})();
function syncFxMode(){const mode=document.querySelector('#fx-mode'),provider=document.querySelector('#fx-provider'),key=document.querySelector('#fx-key-fields');if(!mode||!provider||!key)return;provider.value=mode.value==='live'?'currencylayer':'frankfurter';key.hidden=mode.value!=='live';}
document.querySelector('#fx-mode')?.addEventListener('change',syncFxMode);
document.querySelector('#fx-provider')?.addEventListener('change',event=>{document.querySelector('#fx-mode').value=event.target.value==='frankfurter'?'reference':'live';syncFxMode();});syncFxMode();

// Cash-on-delivery: local clipboard, CSV selection, and live dashboard counts.
document.querySelector('[data-cod-copy]')?.addEventListener('click',async()=>{
 const source=document.querySelector('[data-cod-copy-source]'),status=document.querySelector('[data-cod-copy-status]');
 try{await navigator.clipboard.writeText(source.value);status.textContent='收货信息已复制';}catch{source.select();status.textContent='请按 Ctrl+C 复制所选收货信息';}
});
document.querySelector('[data-cod-select-all]')?.addEventListener('change',e=>document.querySelectorAll('[name="order_ids"]').forEach(input=>input.checked=e.target.checked));
document.querySelector('[data-cod-import-file]')?.addEventListener('change',async e=>{
 const file=e.target.files[0];if(!file)return;if(file.size>1000000){alert('CSV最多1MB');return;}
 document.querySelector('[data-cod-import-text]').value=await file.text();
});
if(document.querySelector('[data-cod-stats]')){
 let pending=false;async function refreshCod(){if(document.hidden||pending)return;pending=true;try{const r=await fetch('/admin/cod/stats.json');if(!r.ok)return;const stats=await r.json();document.querySelectorAll('[data-cod-count]').forEach(node=>{node.textContent=stats[node.dataset.codCount]??0;});}catch{}finally{pending=false;}}
 setInterval(refreshCod,15000);document.addEventListener('visibilitychange',refreshCod);
}

document.querySelector('[data-service-attachment-form]')?.addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget,button=form.querySelector('button'),status=form.querySelector('[data-upload-status]');button.disabled=true;
 try{for(const file of form.querySelector('[type="file"]').files){if(file.size>3*1024*1024)throw new Error('图片最多3MB');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(file);});const response=await fetch('/admin/service/attachment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf:form.querySelector('[name="csrf"]').value,case_id:form.dataset.caseId,name:file.name,data})});if(!response.ok)throw new Error('上传失败，请检查图片格式、大小或张数');}location.reload();}catch(err){status.textContent=err.message||'上传失败';button.disabled=false;}
});

if(document.querySelector('[data-service-count]')){
 let servicePending=false;const refreshService=async()=>{if(document.hidden||servicePending)return;servicePending=true;try{const r=await fetch('/admin/service/stats.json');if(!r.ok)return;const counts=await r.json();document.querySelectorAll('[data-service-count]').forEach(n=>n.textContent=counts[n.dataset.serviceCount]??0);}catch{}finally{servicePending=false;}};setInterval(refreshService,15000);
}

if(document.querySelector('[data-center-count]')){
 let centerPending=false;async function refreshCenter(){if(document.hidden||centerPending)return;centerPending=true;try{const r=await fetch('/admin/orders/stats.json');if(!r.ok)return;const counts=await r.json();document.querySelectorAll('[data-center-count]').forEach(n=>n.textContent=counts[n.dataset.centerCount]??0);}catch{}finally{centerPending=false;}}
 setInterval(refreshCenter,15000);document.addEventListener('visibilitychange',refreshCenter);
}

// 批量导入上传：FormData 携带 webkitRelativePath（目录名=编号），响应为服务端渲染的预览页。
const importForm=document.querySelector('form[data-upload]');
if(importForm){
  importForm.addEventListener('submit',async event=>{
    event.preventDefault();
    const button=importForm.querySelector('button');button.disabled=true;
    const status=importForm.querySelector('#import-image-hint');if(status)status.textContent='正在上传与校验…';
    try{
      const fd=new FormData();
      for(const input of importForm.querySelectorAll('input[type=file]')){
        if(!input.name)continue;
        for(const file of input.files)fd.append(input.name,file,input.webkitRelativePath||file.name);
      }
      for(const [key,value] of new FormData(importForm))if(typeof value==='string')fd.append(key,value);
      const response=await fetch(importForm.action,{method:'POST',body:fd,headers:{'X-CSRF-Token':importForm.elements.csrf.value}});
      const html=await response.text();
      document.open();document.write(html);document.close();
      history.replaceState({},'',response.url||'/admin/import');
    }catch(err){
      if(status)status.textContent='上传失败：'+(err.message||err);
      button.disabled=false;
    }
  });
}

// 满件优惠编辑器：添加/移除档位行；移除至少保留一行，否则提交会被服务端拒绝。
const tierList=document.querySelector('[data-promotion-tiers]');
if(tierList){
  const tierRow=()=>{const tr=document.createElement('tr');
    tr.innerHTML='<td><input name="minimumQuantity" type="number" min="1" max="1000" required aria-label="最低件数"></td><td><input name="discountAmount" type="number" min="0.01" max="9999999" step="0.01" required aria-label="优惠金额（USD）"></td><td><button type="button" data-remove-tier>移除</button></td>';
    tr.querySelector('[data-remove-tier]').addEventListener('click',()=>{if(tierList.rows.length>1)tr.remove();});
    return tr;};
  document.querySelector('[data-add-tier]')?.addEventListener('click',()=>tierList.append(tierRow()));
  tierList.addEventListener('click',event=>{
    const button=event.target.closest('[data-remove-tier]');
    if(button&&tierList.rows.length>1)button.closest('tr').remove();
  });
}
