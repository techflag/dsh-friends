import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decrypt as decryptBackup } from 'nostr-tools/nip49';
import { bech32 } from '@scure/base';
import { initialStored, type Stored, type Store } from '../src/model.js';
import { FriendsService } from '../src/service.js';
import { localRelay } from './relay-fixture.js';

const password='a-test-password-12345';
const profile=(name:string)=>({name,bio:'合成测试资料',tags:['插件开发'],looking:'交流工具'});
function memoryStore(){let value=initialStored();return {read:()=>structuredClone(value),write:async(next:Stored)=>{value=structuredClone(next);}} satisfies Store;}
async function until(condition:()=>boolean){const end=Date.now()+5000;while(!condition()){if(Date.now()>end)throw new Error('Expected condition not reached');await new Promise(resolve=>setTimeout(resolve,15));}}

test('identity is explicitly created, encrypted at rest, recoverable and locked across restart',async()=>{
  const store=memoryStore();const first=new FriendsService(store,[]);
  try{
    assert.equal(first.snapshot().identity,'missing');assert.equal(first.snapshot().networkApproved,false);
    await first.command('identity.create',{password,profile:profile('甲')});
    assert.equal(first.snapshot().identity,'ready');assert.equal(first.snapshot().discoverable,false);
    const publicKey=first.snapshot().publicKey;
    const backup=await first.command('identity.backup',{}) as {encryptedBackup:string};
    assert.equal(backup.encryptedBackup.startsWith('ncryptsec1'),true);
    assert.equal(JSON.stringify(first.snapshot()).includes(backup.encryptedBackup),false);
    await first.command('identity.lock',{});
    await assert.rejects(first.command('identity.unlock',{password:'incorrect'}));
    assert.equal(first.snapshot().identity,'locked');
    await first.command('identity.unlock',{password});
    assert.equal(first.snapshot().publicKey,publicKey);
    const second=new FriendsService(memoryStore(),[]);
    try{await second.command('identity.import',{password,vault:backup.encryptedBackup});assert.equal(second.snapshot().publicKey,publicKey);}finally{await second.close();}
  }finally{await first.close();}
});

test('uses the published NIP-49 decrypt vector and rejects hostile work factors before decryption',async()=>{
  const vector='ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p';
  assert.equal(Buffer.from(decryptBackup(vector,'nostr')).toString('hex'),'3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683');
  const decoded=bech32.decode(vector,300),bytes=bech32.fromWords(decoded.words);bytes[1]=30;
  const malicious=bech32.encode('ncryptsec',bech32.toWords(bytes),300);
  const service=new FriendsService(memoryStore(),[]);
  try{await assert.rejects(service.command('identity.import',{password,vault:malicious}),/计算成本/);assert.equal(service.snapshot().identity,'missing');}finally{await service.close();}
});

test('a failed identity write never exposes an unpersisted unlocked identity',async()=>{
  const initial=initialStored();const service=new FriendsService({read:()=>initial,write:async()=>{throw new Error('disk unavailable');}},[]);
  try{await assert.rejects(service.command('identity.create',{password,profile:profile('甲')}));assert.equal(service.snapshot().identity,'missing');}finally{await service.close();}
});

test('two real relay clients discover, approve, encrypt, retry and recover without public writes',async()=>{
  const relay=await localRelay(),storeA=memoryStore(),storeB=memoryStore();
  let a=new FriendsService(storeA,[relay.url]);const b=new FriendsService(storeB,[relay.url]);
  try{
    await a.command('identity.create',{password,profile:profile('测试甲')});
    await b.command('identity.create',{password,profile:profile('测试乙')});
    const keyA=a.snapshot().publicKey!,keyB=b.snapshot().publicKey!;
    await a.command('network.connect',{confirmed:true});await b.command('network.connect',{confirmed:true});
    assert.equal(relay.events.size,0,'connect alone must not publish a profile');
    await a.command('discovery.visibility',{visible:true,confirmed:true});await b.command('discovery.visibility',{visible:true,confirmed:true});
    await until(()=>a.snapshot().peers.length===1&&b.snapshot().peers.length===1);
    const requestId=randomUUID();await a.command('friend.request',{peer:keyB,id:requestId,text:'一起交流？'});
    await until(()=>b.snapshot().invitations.length===1);
    await b.command('friend.accept',{id:requestId});
    await until(()=>a.snapshot().friends.length===1&&b.snapshot().friends.length===1);
    const secretText='只给测试乙的私聊正文';
    await a.command('message.send',{peer:keyB,id:randomUUID(),text:secretText});
    await until(()=>b.snapshot().messages.some(m=>m.text===secretText));
    assert.equal(a.snapshot().messages[0].status,'relay-accepted');
    assert.equal(JSON.stringify([...relay.events.values()]).includes(secretText),false,'relay must never receive plaintext');
    assert.equal(JSON.stringify(storeA.read()).includes(secretText),false,'local history must be encrypted');
    relay.rejectPublishes=true;
    const retryId=randomUUID();await a.command('message.send',{peer:keyB,id:retryId,text:'失败后只显示一次'});
    assert.equal(a.snapshot().messages.find(m=>m.id===retryId)?.status,'failed');
    relay.rejectPublishes=false;
    await a.command('message.retry',{});
    await until(()=>b.snapshot().messages.some(m=>m.id===retryId));
    assert.equal(b.snapshot().messages.filter(m=>m.id===retryId).length,1);
    assert.equal(a.snapshot().messages.filter(m=>m.id===retryId).length,1);
    await a.command('message.send',{peer:keyB,id:retryId,text:'失败后只显示一次'});
    assert.equal(a.snapshot().messages.filter(m=>m.id===retryId).length,1,'duplicate browser submission must keep the same logical message');
    a.transport.close();
    const restartId=randomUUID();await a.command('message.send',{peer:keyB,id:restartId,text:'重启后恢复的待发消息'});
    assert.equal(a.snapshot().pending,1);
    await a.close();a=new FriendsService(storeA,[relay.url]);
    assert.equal(a.snapshot().identity,'locked');assert.equal(a.snapshot().messages.length,0);
    await a.command('identity.unlock',{password});
    await until(()=>b.snapshot().messages.some(m=>m.id===restartId));
    assert.equal(a.snapshot().pending,0);assert.equal(b.snapshot().messages.filter(m=>m.id===restartId).length,1);
    await a.command('discovery.visibility',{visible:false,confirmed:true});
    await until(()=>b.snapshot().peers.every(p=>p.publicKey!==keyA));
    await b.command('friend.block',{peer:keyA,blocked:true});
    const blockedId=randomUUID();await a.command('message.send',{peer:keyB,id:blockedId,text:'屏蔽后不应显示'});
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(b.snapshot().messages.some(m=>m.id===blockedId),false);
    assert.equal(relay.url.startsWith('ws://127.0.0.1:'),true);
  }finally{await a.close();await b.close();await relay.close();}
});

test('crossed invitations can be accepted without leaving both users stuck',async()=>{
  const relay=await localRelay(),a=new FriendsService(memoryStore(),[relay.url]),b=new FriendsService(memoryStore(),[relay.url]);
  try{
    await a.command('identity.create',{password,profile:profile('交叉甲')});await b.command('identity.create',{password,profile:profile('交叉乙')});
    await a.command('network.connect',{confirmed:true});await b.command('network.connect',{confirmed:true});
    await a.command('discovery.visibility',{visible:true,confirmed:true});await b.command('discovery.visibility',{visible:true,confirmed:true});
    const idA=randomUUID(),idB=randomUUID();
    await Promise.all([a.command('friend.request',{peer:b.snapshot().publicKey,id:idA,text:'你好乙'}),b.command('friend.request',{peer:a.snapshot().publicKey,id:idB,text:'你好甲'})]);
    await until(()=>a.snapshot().invitations.some(i=>i.direction==='incoming')&&b.snapshot().invitations.some(i=>i.direction==='incoming'));
    await b.command('friend.accept',{id:idA});
    await until(()=>a.snapshot().friends.length===1&&b.snapshot().friends.length===1);
    assert.equal(a.snapshot().invitations.length,0);assert.equal(b.snapshot().invitations.length,0);
  }finally{await a.close();await b.close();await relay.close();}
});

test('corrupt encrypted history stays locked and is never replaced with an empty history',async()=>{
  const store=memoryStore(),first=new FriendsService(store,[]);
  await first.command('identity.create',{password,profile:profile('测试')});
  await first.command('profile.update',profile('测试更新'));await first.close();
  const damaged={...store.read(),encryptedData:'broken-authenticated-ciphertext'};await store.write(damaged);
  const second=new FriendsService(store,[]);
  try{await assert.rejects(second.command('identity.unlock',{password}),/原文件未覆盖/);assert.equal(second.snapshot().identity,'locked');assert.deepEqual(store.read(),damaged);}finally{await second.close();}
});
