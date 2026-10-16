import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityStatus } from './policy.mjs';
test('threshold crossing, deduplication, re-arm', () => {
  let warned = false;
  for (const [percent, send] of [[79,false],[81,true],[83,false],[78,false],[82,true]]) {
    const result = capacityStatus(percent * 5_000_000,500,80,warned);
    assert.equal(result.sendAlert,send); warned=result.warned;
  }
  assert.equal(capacityStatus(400_000_000).status,'WARNING');
  assert.equal(capacityStatus(49_000_000).usagePercent,9.8);
});
test('invalid metrics fail closed',()=>{for(const value of [-1,NaN,Infinity])assert.throws(()=>capacityStatus(value));});
