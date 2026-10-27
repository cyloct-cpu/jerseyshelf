import test from 'node:test';
import assert from 'node:assert/strict';
import {clientAddress} from '../packages/contracts/client-address.mjs';
const req=(peer,header)=>({socket:{remoteAddress:peer},headers:{'x-real-ip':header}});
test('real visitor addresses are trusted only from explicitly enabled loopback proxies',()=>{
  assert.equal(clientAddress(req('127.0.0.1','203.0.113.8'),true),'203.0.113.8');
  assert.equal(clientAddress(req('::1','2001:db8::8'),true),'2001:db8::8');
  assert.equal(clientAddress(req('127.0.0.1','203.0.113.8')),'127.0.0.1');
  assert.equal(clientAddress(req('203.0.113.9','203.0.113.8'),true),'203.0.113.9');
  for(const value of ['invalid','203.0.113.8, 203.0.113.9',['203.0.113.8']])
    assert.equal(clientAddress(req('127.0.0.1',value),true),'127.0.0.1');
});
