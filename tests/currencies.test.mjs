import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currencies,currencyMap,convertMinor,convertCart,formatMinor,parseCurrencyAmount } from '../packages/contracts/currencies.mjs';
test('货币清单、小数位和整数舍入',()=>{
  assert.equal(currencies.length,155);assert.equal(currencyMap.get('JPY').minor,0);assert.equal(currencyMap.get('KWD').minor,3);
  assert.equal(convertMinor(101,{rate:'150.123',minor:0}),152);
  assert.equal(convertMinor(101,{rate:'0.3',minor:3}),303);
  assert.equal(convertMinor(1,{rate:'0.5',minor:2}),1);
  const cart=convertCart({items:[{price:101,quantity:3}],shipping:0},{rate:'150.123',minor:0});assert.equal(cart.total,456);assert.equal(cart.subtotal,cart.items[0].lineTotal);
  assert.match(formatMinor(303,'KWD','en'),/0\.303/);assert.match(formatMinor(152,'JPY','en'),/152/);
  assert.equal(parseCurrencyAmount('0.303',{minor:3}),303);assert.equal(parseCurrencyAmount('152',{minor:0}),152);assert.throws(()=>parseCurrencyAmount('1.2',{minor:0}));
});
