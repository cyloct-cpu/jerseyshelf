import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandSearchTerm, normalizeSearch, searchTerms } from '../packages/contracts/search-keywords.mjs';
import { localizedCountryAliases } from '../packages/contracts/country-names.mjs';
test('各语言国家名称映射到同一分类，且不扩大为大量SQL搜索词',()=>{
  const collections=[{id:1,slug:'germany',name:'德国'},{id:2,slug:'france',name:'法国'},{id:3,slug:'spain',name:'西班牙'},{id:4,slug:'south-korea',name:'韩国'}];
  for(const [name,id]of [['Deutschland',1],['德国',1],['Germany',1],['ドイツ',1],['독일',1],['ألمانيا',1],['Allemagne',1],['フランス',2],['프랑스',2],['فرنسا',2],['España',3]]){
    const result=expandSearchTerm(normalizeSearch(name),collections);assert.deepEqual(result.ids,[id],name);assert.ok(result.words.length<15,name);
  }
  assert.deepEqual(searchTerms('South Korea jersey'),['south korea','jersey']);assert.deepEqual(searchTerms('Pays de Galles shirt'),['pays de galles','shirt']);
  assert.deepEqual(searchTerms(' Deutschland  jersey '),['deutschland','jersey']);assert.deepEqual(expandSearchTerm('not-a-country',collections).ids,[]);
});
test('生成的国家名称别名均能反查自身分类',()=>{
  const collections=Object.keys(localizedCountryAliases).map((slug,index)=>({id:index+1,slug,name:slug}));
  for(const collection of collections)for(const alias of localizedCountryAliases[collection.slug])assert.ok(expandSearchTerm(normalizeSearch(alias),collections).ids.includes(collection.id),collection.slug+': '+alias);
});
