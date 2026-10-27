const editor=document.querySelector('#product-recommendation-editor');
if(editor){
  const selected=editor.querySelector('#selected-recommendations'),hidden=editor.querySelector('#recommendations-json'),status=editor.querySelector('#recommendation-status'),candidates=editor.querySelector('#recommendation-candidates'),more=editor.querySelector('#more-recommendations');
  const ids=()=>[...selected.children].map(row=>Number(row.dataset.recommendationId));
  const sync=()=>{hidden.value=JSON.stringify(ids());for(const button of candidates.querySelectorAll('[data-rec-add]')){button.disabled=ids().includes(Number(button.dataset.recAdd))||ids().length>=30;button.textContent=ids().includes(Number(button.dataset.recAdd))?'已选择':'添加';}};
  function row(p){
    const item=document.createElement('li');item.dataset.recommendationId=p.id;
    if(p.images[0]){const img=document.createElement('img');img.src=p.images[0]+'?width=480';img.alt='';img.loading='lazy';item.append(img);}
    const title=document.createElement('span');title.textContent=p.title;
    const detail=document.createElement('small');detail.textContent=`#${p.id} · ${p.active?'已上架':'已下架'}${p.images.length?'':' · 无图'}`;title.append(detail);item.append(title);
    const controls=document.createElement('div');controls.className='actions';
    for(const [label,move]of [['↑','-1'],['↓','1'],['移除',null]]){const button=document.createElement('button');button.type='button';button.textContent=label;if(move){button.dataset.recMove=move;button.setAttribute('aria-label',move==='-1'?'上移推荐商品':'下移推荐商品');}else button.dataset.recRemove='';controls.append(button);}
    item.append(controls);return item;
  }
  let page=1,pages=1,products=new Map(),controller;
  async function search(append=false){
    controller?.abort();controller=new AbortController();if(!append){page=1;products.clear();candidates.replaceChildren();}
    more.hidden=true;status.textContent='正在查找…';
    try{
      const params=new URLSearchParams({q:editor.querySelector('#recommendation-search').value,collection:editor.querySelector('#recommendation-collection').value,page,exclude:editor.dataset.productId});
      const response=await fetch('/admin/recommendations/products.json?'+params,{signal:controller.signal});if(!response.ok)throw new Error('查询失败，请刷新后台后重试');
      const result=await response.json();pages=result.pages;
      for(const p of result.products){products.set(p.id,p);const item=row(p);item.removeAttribute('data-recommendation-id');item.lastElementChild.replaceChildren();const button=document.createElement('button');button.type='button';button.dataset.recAdd=p.id;button.textContent='添加';item.lastElementChild.append(button);candidates.append(item);}
      status.textContent=`找到 ${result.count} 件商品 · 第 ${page} 页`;more.hidden=page>=pages;sync();
    }catch(err){if(err.name!=='AbortError')status.textContent=err.message;}
  }
  editor.querySelector('#find-recommendations').addEventListener('click',()=>search());
  editor.querySelector('#recommendation-search').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();search();}});
  more.addEventListener('click',()=>{if(page<pages){page++;search(true);}});
  editor.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.hasAttribute('data-rec-add')){const p=products.get(Number(button.dataset.recAdd));if(p&&!ids().includes(p.id)&&ids().length<30)selected.append(row(p));}
    const item=button.closest('[data-recommendation-id]');
    if(item&&button.hasAttribute('data-rec-remove'))item.remove();
    if(item&&button.dataset.recMove==='-1'&&item.previousElementSibling)selected.insertBefore(item,item.previousElementSibling);
    if(item&&button.dataset.recMove==='1'&&item.nextElementSibling)selected.insertBefore(item.nextElementSibling,item);
    if(button.id==='restore-auto-recommendations'){selected.replaceChildren();editor.querySelector('#recommendation-mode').value='auto_fill';}
    sync();
  });
  editor.closest('form').addEventListener('submit',sync);sync();
}
