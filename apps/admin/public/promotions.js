(()=>{
  const form=document.querySelector('#promotion-form');if(!form)return;
  const body=form.querySelector('[data-promotion-tiers]'),add=form.querySelector('[data-add-tier]');
  function sync(){add.disabled=body.children.length>=10;}
  add.addEventListener('click',()=>{if(body.children.length>=10)return;body.append(document.querySelector('#promotion-tier-template').content.cloneNode(true));sync();body.lastElementChild.querySelector('input').focus();});
  body.addEventListener('click',event=>{const button=event.target.closest('[data-remove-tier]');if(button){button.closest('tr').remove();sync();}});
  sync();
})();
