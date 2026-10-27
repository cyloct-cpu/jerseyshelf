import { int, cents, InputError } from './validation.mjs';

export const defaultQuantityPromotion={enabled:true,tiers:[{quantity:3,amount:500},{quantity:8,amount:1000},{quantity:10,amount:1800}]};

export function parseQuantityPromotion(input){
  const enabled=input.enabled===true||input.enabled==='1';
  const quantities=Array.isArray(input.minimumQuantity)?input.minimumQuantity:input.minimumQuantity===undefined?[]:[input.minimumQuantity];
  const amounts=Array.isArray(input.discountAmount)?input.discountAmount:input.discountAmount===undefined?[]:[input.discountAmount];
  if(quantities.length!==amounts.length||quantities.length>10)throw new InputError('优惠档位最多 10 个，件数与金额必须对应');
  const tiers=quantities.map((quantity,i)=>({quantity:int(quantity,'优惠最低件数',1,1000),amount:cents(amounts[i],'优惠金额')})).sort((a,b)=>a.quantity-b.quantity);
  if(enabled&&!tiers.length)throw new InputError('请至少填写一个优惠档位');
  for(const [i,tier] of tiers.entries()){
    if(tier.amount<=0)throw new InputError('优惠金额必须大于零');
    if(i&&(tier.quantity===tiers[i-1].quantity||tier.amount<=tiers[i-1].amount))throw new InputError('档位件数不能重复，优惠金额必须随件数递增');
  }
  return {enabled,tiers};
}

export function quantityDiscount(quantity,subtotal,config=defaultQuantityPromotion){
  const tier=config.enabled?[...config.tiers].reverse().find(t=>quantity>=t.quantity):null;
  const discount=tier?Math.min(subtotal,tier.amount):0;
  return {discount,promotion:discount?{name:'满件优惠',minimumQuantity:tier.quantity,amount:tier.amount}:null};
}
