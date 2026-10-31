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

test('public lobby works before identity or friendship, with replies, stable retries and restart recovery',async()=>{
  const relay=await localRelay(),store=memoryStore();let a=new FriendsService(store,[relay.url]);
  const guest=new FriendsService(memoryStore(),[relay.url]);
  try{
    await guest.command('network.connect',{confirmed:true});
    assert.equal(guest.snapshot().identity,'missing');assert.equal(relay.events.size,0);
    await a.command('identity.create',{password,profile:profile('大厅测试甲')});
    await a.command('network.connect',{confirmed:true});
    const id=randomUUID();await a.command('lobby.send',{id,text:'公开大厅：第一次参与，不需要加好友。',confirmed:true});
    await until(()=>guest.snapshot().lobby.length===1);
    assert.equal(guest.snapshot().friends.length,0);assert.equal(guest.snapshot().identity,'missing');
    assert.equal(a.snapshot().lobby[0].status,'relay-accepted');
    assert.equal([...relay.events.values()].filter(e=>e.kind===30388).length,0,'speaking must not opt into full-profile discovery');
    await assert.rejects(guest.command('lobby.send',{id:randomUUID(),text:'缺少身份',confirmed:true}),/解锁/);
    await guest.command('identity.create',{password,profile:profile('大厅测试乙')});
    const parent=a.snapshot().lobby[0].id;
    await guest.command('lobby.send',{id:randomUUID(),text:'这是对第一句话的回复。',replyTo:parent,confirmed:true});
    await until(()=>a.snapshot().lobby.length===2);
    assert.equal(a.snapshot().lobby.find(p=>p.replyTo===parent)?.text,'这是对第一句话的回复。');
    await a.command('lobby.send',{id,text:'公开大厅：第一次参与，不需要加好友。',confirmed:true});
    assert.equal([...relay.events.values()].filter(e=>e.kind===9).length,2,'a repeated request is the same event');
    await assert.rejects(a.command('lobby.send',{id,text:'悄悄改掉同一次请求',confirmed:true}),/内容不一致/);
    relay.rejectPublishes=true;
    const retryId=randomUUID(),text='公开消息故障后，重启恢复并只投递一次。';
    await a.command('lobby.send',{id:retryId,text,confirmed:true});
    assert.equal(a.snapshot().lobby.find(p=>p.text===text)?.status,'failed');
    assert.equal(JSON.stringify(store.read()).includes(text),false,'the durable queue is encrypted');
    const eventId=a.snapshot().lobby.find(p=>p.text===text)!.id;
    await a.close();a=new FriendsService(store,[relay.url]);relay.rejectPublishes=false;
    await a.command('identity.unlock',{password});
    await until(()=>guest.snapshot().lobby.some(p=>p.id===eventId));
    assert.equal(a.snapshot().pending,0);assert.equal(guest.snapshot().lobby.filter(p=>p.id===eventId).length,1);
    await guest.command('friend.block',{peer:a.snapshot().publicKey,blocked:true});
    assert.equal(guest.snapshot().lobby.some(p=>p.publicKey===a.snapshot().publicKey),false);
    await guest.command('identity.lock',{});
    assert.equal(guest.snapshot().identity,'locked');
    await a.command('lobby.send',{id:randomUUID(),text:'锁定身份后仍可只读浏览。',confirmed:true});
    await until(()=>guest.snapshot().lobby.some(p=>p.text==='锁定身份后仍可只读浏览。'));
    await guest.command('network.disconnect',{});
    assert.equal(guest.snapshot().networkApproved,false);
  }finally{await a.close();await guest.close();await relay.close();}
});

test('NIP-42 private authentication is scoped, ephemeral and separate from guest public reading',async()=>{
  const relay=await localRelay({requirePrivateAuth:true}),a=new FriendsService(memoryStore(),[relay.url]),b=new FriendsService(memoryStore(),[relay.url]),guest=new FriendsService(memoryStore(),[relay.url]),refused=new FriendsService(memoryStore(),[relay.url]);
  try{
    await guest.command('network.connect',{confirmed:true});assert.equal(relay.authEvents.length,0);
    await a.command('identity.create',{password,profile:profile('验证甲')});await b.command('identity.create',{password,profile:profile('验证乙')});
    await a.command('network.connect',{confirmed:true});await b.command('network.connect',{confirmed:true});
    await until(()=>a.snapshot().relays[0].privateState==='ready'&&b.snapshot().relays[0].privateState==='ready');
    assert.equal(relay.authEvents.length,2);assert(relay.authEvents.every(e=>e.kind===22242&&e.content===''));
    assert.equal([...relay.events.values()].some(e=>e.kind===22242),false,'authentication must never be broadcast');
    await a.command('lobby.send',{id:randomUUID(),text:'公共发言与私聊验证分开。',confirmed:true});await b.command('lobby.send',{id:randomUUID(),text:'不公开完整名片也能准备私聊。',confirmed:true});
    await until(()=>guest.snapshot().lobby.length===2);assert.equal(guest.snapshot().identity,'missing');
    const id=randomUUID();await a.command('friend.request',{peer:b.snapshot().publicKey,id,text:'从大厅继续聊'});await until(()=>b.snapshot().invitations.some(i=>i.id===id));await b.command('friend.accept',{id});await until(()=>a.snapshot().friends.length===1);
    await a.command('message.send',{peer:b.snapshot().publicKey,id:randomUUID(),text:'验证后收到的加密私聊'});await until(()=>b.snapshot().messages.some(m=>m.text==='验证后收到的加密私聊'));
    assert.equal(a.snapshot().friends[0].name,'验证乙');assert.equal(b.snapshot().friends[0].name,'验证甲');
    relay.rejectAuth=true;await refused.command('identity.create',{password,profile:profile('被拒验证测试')});await refused.command('network.connect',{confirmed:true});await until(()=>refused.snapshot().relays[0].privateState==='failed');assert.equal(refused.snapshot().relays[0].state,'connected','private authentication failure must not close the public chat subscription');
    await a.command('lobby.send',{id:randomUUID(),text:'私聊验证失败仍可以看大厅。',confirmed:true});await until(()=>refused.snapshot().lobby.some(p=>p.text==='私聊验证失败仍可以看大厅。'));
  }finally{await a.close();await b.close();await guest.close();await refused.close();await relay.close();}
});

test('maintenance drains every durable lobby batch and prepares the inbox after background recovery',async()=>{
  const relay=await localRelay(),store=memoryStore();let sender=new FriendsService(store,[relay.url]);const reader=new FriendsService(memoryStore(),[relay.url]);
  try{
    await reader.command('network.connect',{confirmed:true});await sender.command('identity.create',{password,profile:profile('批次恢复测试')});await sender.command('network.connect',{confirmed:true});relay.rejectPublishes=true;
    for(let i=0;i<3;i++)await sender.command('lobby.send',{id:randomUUID(),text:'批次恢复消息 '+i,confirmed:true});
    assert.equal(sender.snapshot().pending,3);await sender.close();relay.rejectPublishes=false;sender=new FriendsService(store,[relay.url]);await sender.command('identity.unlock',{password});
    const deadline=Date.now()+8000;while(sender.snapshot().pending>0){assert(Date.now()<deadline,'maintenance must drain the remaining batch without more clicks');await new Promise(r=>setTimeout(r,30));}
    await until(()=>reader.snapshot().lobby.length===3);assert.deepEqual(store.read().inboxUrls,[relay.url]);assert([...relay.events.values()].some(e=>e.kind===10050&&e.pubkey===sender.snapshot().publicKey));
  }finally{await sender.close();await reader.close();await relay.close();}
});

test('default rooms isolate live messages, replies, operation IDs and restore their public cache without unlocking',async()=>{
  const relay=await localRelay(),store=memoryStore();let a=new FriendsService(store,[relay.url]);const b=new FriendsService(memoryStore(),[relay.url]);
  try{
    await a.command('identity.create',{password,profile:profile('甲')});
    await a.command('network.connect',{confirmed:true});await b.command('network.connect',{confirmed:true});
    await a.command('lobby.send',{id:randomUUID(),text:'大厅旧协议',confirmed:true});
    const id=randomUUID();await a.command('lobby.send',{id,text:'插件交流消息',room:'builders',confirmed:true});
    await until(()=>b.snapshot().lobby.length===2);
    const builder=b.snapshot().lobby.find(p=>p.room==='builders')!;
    assert.equal(b.snapshot().lobby.filter(p=>p.room==='general').length,1);
    await assert.rejects(a.command('lobby.send',{id:randomUUID(),text:'不能跨房间回复',room:'random',replyTo:builder.id,confirmed:true}),/原消息/);
    await assert.rejects(a.command('lobby.send',{id,text:'插件交流消息',room:'random',confirmed:true}),/不一致/);
    await b.command('room.select',{room:'builders'});
    await a.command('room.select',{room:'random'});await a.close();
    a=new FriendsService(store,[]);
    assert.equal(a.snapshot().identity,'locked');assert.equal(a.snapshot().selectedRoom,'random');
    assert.equal(a.snapshot().lobby.length,2,'public cache is readable offline without exposing private identity');
    await assert.rejects(a.command('room.select',{room:'user-room'}));
  }finally{await a.close();await b.close();await relay.close();}
});

test('history replays absent-time messages, pages beyond 30 days and keeps same-second boundaries intact',async()=>{
  const relay=await localRelay(),store=memoryStore();let reader=new FriendsService(store,[relay.url]);
  const {generateSecretKey,finalizeEvent}=await import('nostr-tools/pure');
  const secret=generateSecretKey(),t=Math.floor(Date.now()/1000)-40*86400;
  const seed=(text:string,time:number,tag='dsh-friends-builders-v1')=>{const event=finalizeEvent({kind:9,created_at:time,tags:[['t',tag],['name','历史测试']],content:text},secret);relay.events.set(event.id,event);return event;};
  for(let i=0;i<75;i++)seed(`同秒历史 ${i}`,t);
  seed('更早一条',t-10);seed('其他房间',t,'dsh-friends-random-v1');
  try{
    await reader.command('network.connect',{confirmed:true});
    await reader.command('lobby.history',{room:'builders'});
    assert.equal(reader.snapshot().lobby.filter(p=>p.room==='builders').length,75,'one full timestamp boundary is fetched without skipping tied IDs');
    await reader.command('lobby.history',{room:'builders'});
    assert.equal(reader.snapshot().lobby.filter(p=>p.room==='builders').length,76);
    await reader.command('lobby.history',{room:'builders'});assert.equal(reader.snapshot().roomHistory.builders.exhausted,true);
    await reader.close();
    seed('关闭期间的新消息',Math.floor(Date.now()/1000)-10);
    reader=new FriendsService(store,[relay.url]);await reader.start();
    await until(()=>reader.snapshot().lobby.some(p=>p.text==='关闭期间的新消息'));
    assert(reader.snapshot().lobby.some(p=>p.text==='更早一条'),'cached history survives reopening');
    await reader.command('network.disconnect',{});
    await assert.rejects(reader.command('lobby.history',{room:'general'}),/先连接/);
    assert(reader.snapshot().lobby.some(p=>p.text==='关闭期间的新消息'));
  }finally{await reader.close();await relay.close();}
});

test('first connection failure automatically recovers when the relay becomes available',async()=>{
  let relay=await localRelay();const url=relay.url,port=Number(new URL(url).port);await relay.close();
  const reader=new FriendsService(memoryStore(),[url]);
  try{
    await reader.command('network.connect',{confirmed:true});assert.equal(reader.snapshot().relays[0].state,'failed');
    relay=await localRelay({port});
    const deadline=Date.now()+8000;
    while(reader.snapshot().relays[0].state!=='connected'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    assert.equal(reader.snapshot().relays[0].state,'connected');assert.equal(reader.snapshot().error,undefined);
  }finally{await reader.close();await relay.close();}
});

test('notification feed excludes initial history, own events and blocked senders, and persists opt-in',async()=>{
  const relay=await localRelay(),store=memoryStore();let reader=new FriendsService(store,[relay.url]);const writer=new FriendsService(memoryStore(),[relay.url]);
  try{
    await writer.command('identity.create',{password,profile:profile('提醒测试甲')});await writer.command('network.connect',{confirmed:true});
    await writer.command('lobby.send',{id:randomUUID(),text:'进入之前的历史',confirmed:true});
    await reader.command('network.connect',{confirmed:true});await until(()=>reader.snapshot().lobby.length===1);
    assert.deepEqual((await reader.command('notifications.poll',{}) as {items:unknown[]}).items,[]);
    await reader.command('notifications.set',{enabled:true});
    await writer.command('lobby.send',{id:randomUUID(),text:'进入之后的实时消息',room:'builders',confirmed:true});
    await until(()=>reader.snapshot().lobby.length===2);
    let notices=await reader.command('notifications.poll',{}) as {enabled:boolean;items:{room:string}[]};assert(notices.enabled);assert.equal(notices.items.length,1);assert.equal(notices.items[0].room,'builders');
    assert.equal((await writer.command('notifications.poll',{}) as {items:unknown[]}).items.length,0);
    await reader.command('friend.block',{peer:writer.snapshot().publicKey,blocked:true});
    await writer.command('lobby.send',{id:randomUUID(),text:'屏蔽后的消息',confirmed:true});
    await new Promise(r=>setTimeout(r,100));assert.equal((await reader.command('notifications.poll',{}) as {items:unknown[]}).items.length,1);
    await reader.close();reader=new FriendsService(store,[]);assert.equal(reader.snapshot().notificationsEnabled,true);
  }finally{await reader.close();await writer.close();await relay.close();}
});

test('notification waiting never blocks commands, and cleans up on preference change, abort and shutdown',async()=>{
  const service=new FriendsService(memoryStore(),[]);
  try{
    let batch=await service.command('notifications.poll',{}) as {revision:number};
    const pending=service.command('notifications.wait',{after:batch.revision});
    await service.command('notifications.set',{enabled:true});
    batch=await pending as {revision:number};assert(batch.revision>0);
    const controller=new AbortController(),cancelled=service.command('notifications.wait',{after:batch.revision},controller.signal);controller.abort();await cancelled;
    const stopping=service.command('notifications.wait',{after:batch.revision});await service.close();assert.equal((await stopping as {enabled:boolean}).enabled,false);
  }finally{await service.close();}
});

test('automatic local identity restores across restart without sending secrets to the client',async()=>{
  const store=memoryStore(),secrets=new Map<string,string>(),protectedStore={read:async(id:string)=>secrets.get(id),write:async(id:string,value:string)=>{secrets.set(id,value);},remove:async(id:string)=>{secrets.delete(id);}};
  let service=new FriendsService(store,[],protectedStore);
  try{
    await service.command('identity.local',{});const first=service.snapshot();assert(first.localIdentity);assert.equal(first.identity,'ready');assert.equal(secrets.size,1);
    const secret=[...secrets.values()][0];assert(!JSON.stringify(first).includes(secret));assert(!JSON.stringify(store.read()).includes(secret));
    const publicKey=first.publicKey;await service.close();service=new FriendsService(store,[],protectedStore);await service.start();assert.equal(service.snapshot().identity,'ready');assert.equal(service.snapshot().publicKey,publicKey);
    await assert.rejects(service.command('identity.backup',{}),/跨设备/);
  }finally{await service.close();}
});
test('automatic identity never replaces a locked legacy identity or recreates missing protected credentials',async()=>{
  const store=memoryStore();let service=new FriendsService(store,[]);await service.command('identity.create',{password,profile:profile('原有身份')});const key=service.snapshot().publicKey;await service.close();let writes=0;
  const protectedStore={read:async()=>undefined,write:async()=>{writes++;},remove:async()=>{}};
  service=new FriendsService(store,[],protectedStore);
  try{await assert.rejects(service.command('identity.local',{}),/旧版/);assert.equal(service.snapshot().publicKey,key);assert.equal(writes,0);}finally{await service.close();}
});
test('failed automatic identity persistence removes the temporary protected entry and leaves no unlocked identity',async()=>{
  let removed=0;const service=new FriendsService({read:()=>initialStored(),write:async()=>{throw Error('disk unavailable');}},[],{read:async()=>undefined,write:async()=>{},remove:async()=>{removed++;}});
  try{await assert.rejects(service.command('identity.local',{}),/安全保存/);assert.equal(service.snapshot().identity,'missing');assert.equal(removed,1);}finally{await service.close();}
});
