import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantityDiscount, parseQuantityPromotion, defaultQuantityPromotion } from '../packages/contracts/promotions.mjs';
import { convertCart } from '../packages/contracts/currencies.mjs';

test('满件优惠档位边界、最高档不叠加和金额上限',()=>{
  for(const [quantity,discount] of [[0,0],[2,0],[3,500],[7,500],[8,1000],[9,1000],[10,1800],[20,1800]])assert.equal(quantityDiscount(quantity,quantity*1700).discount,discount);
  assert.equal(quantityDiscount(3,303).discount,303);
  assert.equal(quantityDiscount(10,0).discount,0);
  assert.equal(quantityDiscount(10,17000,{...defaultQuantityPromotion,enabled:false}).discount,0);
  assert.equal(quantityDiscount(10,17000).promotion.minimumQuantity,10);
});

test('优惠编辑校验重复门槛、递增金额、数量和输入格式',()=>{
  assert.deepEqual(parseQuantityPromotion({enabled:'1',minimumQuantity:['10','3','8'],discountAmount:['18','5','10']}),defaultQuantityPromotion);
  for(const input of [
    {enabled:'1'},
    {minimumQuantity:['3','3'],discountAmount:['5','10']},
    {minimumQuantity:['3','8'],discountAmount:['10','5']},
    {minimumQuantity:'0',discountAmount:'5'},
    {minimumQuantity:'3',discountAmount:'-1'},
    {minimumQuantity:'3',discountAmount:'0'},
    {minimumQuantity:'3',discountAmount:'5.001'},
    {minimumQuantity:Array(11).fill('3'),discountAmount:Array(11).fill('5')},
    {minimumQuantity:['3','8'],discountAmount:'5'}
  ])assert.throws(()=>parseQuantityPromotion(input));
  assert.deepEqual(parseQuantityPromotion({}),{enabled:false,tiers:[]});
});

test('优惠币种换算与逐件舍入保持合计一致，减免不抵扣运费',()=>{
  const cart={items:[{price:2300,quantity:3}],subtotal:6900,discount:500,shipping:0};
  const gbp=convertCart(cart,{rate:'0.75',minor:2});assert.equal(gbp.subtotal,5175);assert.equal(gbp.discount,375);assert.equal(gbp.total,4800);
  const jpy=convertCart(cart,{rate:'150.123',minor:0});assert.equal(jpy.discount,751);assert.equal(jpy.total,jpy.subtotal-751);
  const kwd=convertCart(cart,{rate:'0.3',minor:3});assert.equal(kwd.discount,1500);assert.equal(kwd.total,19200);
  const capped=convertCart({items:[{price:3,quantity:3}],subtotal:9,discount:9,shipping:1000},{rate:'0.5',minor:2});
  assert.equal(capped.discount,capped.subtotal);assert.equal(capped.total,capped.shipping);
});
