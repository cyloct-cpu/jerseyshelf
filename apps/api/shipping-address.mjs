import {readFileSync} from 'node:fs';
import path from 'node:path';
import {db,now} from './db.mjs';
import {root} from './config.mjs';
import {checkoutCountries} from '../../packages/contracts/checkout.mjs';
import {InputError} from '../../packages/contracts/validation.mjs';

let places;
export function addressLocations(country){
 if(!checkoutCountries.includes(country))throw new InputError('请选择有效的国家/地区');
 if(!places){try{places=JSON.parse(readFileSync(path.join(root,'data/address/places.json'),'utf8')).countries;}catch{places={};}}
 return places[country]||{regions:[],cities:[]};
}
export function savedShippingAddress(user){
 if(!user)return null;
 const row=db.prepare('SELECT address FROM saved_shipping_addresses WHERE user_id=?').get(user.id);
 return row?JSON.parse(row.address):null;
}
export function rememberShippingAddress(user,fields){
 if(!user)return;
 if(!fields.save_address){clearShippingAddress(user);return;}
 const address=Object.fromEntries(['name','country','region','city','address','address2','postal','phone'].map(key=>[key,fields[key]||'']));
 db.prepare('INSERT INTO saved_shipping_addresses(user_id,address,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,updated_at=excluded.updated_at').run(user.id,JSON.stringify(address),now());
}
export function clearShippingAddress(user){
 if(!user)throw new InputError('请先登录',401);
 db.prepare('DELETE FROM saved_shipping_addresses WHERE user_id=?').run(user.id);
}
