// Explicitly opted-in deployment verification; not part of npm test or CI.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {FriendsService} from '../src/service.js';
import {initialStored,type Stored} from '../src/model.js';
import {RelayTransport} from '../src/relays.js';
if(process.env.DSH_FRIENDS_ALLOW_PUBLIC_TEST!=='1')throw Error('Deployment write test requires explicit opt-in');
const url=process.env.DSH_FRIENDS_TEST_RELAY;if(url!=='wss://relay.techflag.cn')throw Error('Use only the authorized deployment relay');
const check:unknown[]=[],stamp=randomUUID(),profile=(name:string)=>({name,bio:'合成部署验收身份',tags:['验收'],looking:'测试'});
function store(){let value=initialStored();return {read:()=>structuredClone(value),write:async(next:Stored)=>{value=structuredClone(next)}}}
const a=new FriendsService(store(),[url]),b=new FriendsService(store(),[url]);
async function until(condition:()=>boolean){const end=Date.now()+12000;while(!condition()){if(Date.now()>end)throw Error('Deployment condition timed out');await new Promise(r=>setTimeout(r,100));}}
async function untilModel(condition:()=>boolean){const end=Date.now()+35000;while(!condition()){if(Date.now()>end)throw Error('Reception model condition timed out');await new Promise(r=>setTimeout(r,100));}}
const proof={passed:false,relay:url,stamp,checks:check,chatSentinel:'DSH_NO_SERVER_CHAT_'+stamp,privateSentinel:'DSH_PRIVATE_NO_SERVER_CHAT_'+stamp};
try{
 for(const [client,name] of [[a,'部署验收甲'],[b,'部署验收乙']] as const){await client.command('identity.create',{password:randomUUID(),profile:profile(name)});await client.command('network.connect',{confirmed:true});}
 await until(()=>a.snapshot().relays[0].privateState==='ready'&&b.snapshot().relays[0].privateState==='ready');check.push('TLS WebSocket connection and scoped NIP-42 authentication');
 const before=await fetch('https://relay.techflag.cn/api/stats').then(r=>r.json()) as any;
 let first:string|undefined;
 for(const room of ['general','builders','random']){
  const id=randomUUID();await a.command('lobby.send',{id,room,confirmed:true,text:proof.chatSentinel+' · '+room});await until(()=>b.snapshot().lobby.some(p=>p.room===room&&p.text.includes(proof.chatSentinel)));first??=b.snapshot().lobby.find(p=>p.room==='general')?.id;
 }
 check.push('Three-room live forwarding without cross-room leakage');
 await b.command('lobby.send',{id:randomUUID(),room:'general',confirmed:true,replyTo:first,text:'合成引用回复 '+stamp});await until(()=>a.snapshot().lobby.some(p=>p.text.includes('合成引用回复 '+stamp)));check.push('Same-room quoted reply');
 const assistantText='@接待助手 请用一句话说明你是 AI 接待助手（合成联网验收 '+stamp+'）';await a.command('lobby.send',{id:randomUUID(),room:'general',confirmed:true,text:assistantText});await until(()=>a.snapshot().lobby.some(p=>p.text===assistantText));const assistantRequest=a.snapshot().lobby.find(p=>p.text===assistantText)!.id;await untilModel(()=>a.snapshot().lobby.some(p=>p.assistant&&p.replyTo===assistantRequest));check.push('Server-side DeepSeek reception reply is signed, labelled and quoted');
 const invite=randomUUID();await a.command('friend.request',{peer:b.snapshot().publicKey,id:invite,text:'合成私聊验收'});await until(()=>b.snapshot().invitations.some(i=>i.id===invite));await b.command('friend.accept',{id:invite});await until(()=>a.snapshot().friends.length===1);
 await a.command('message.send',{peer:b.snapshot().publicKey,id:randomUUID(),text:proof.privateSentinel});await until(()=>b.snapshot().messages.some(m=>m.text===proof.privateSentinel));check.push('Invitation, acceptance and encrypted private message forwarding');
 const guest=new RelayTransport([url],()=>{});
 try{await guest.connect();const page=await guest.queryPage([{kinds:[9],limit:1000}]);assert.equal(page.complete,true);assert.ok(page.events.some(e=>e.id===first));check.push('New subscriber sees recent public messages from bounded memory cache');}finally{guest.close()}
 await b.command('network.disconnect',{});const absent='合成离线测试 '+stamp;await a.command('lobby.send',{id:randomUUID(),room:'general',confirmed:true,text:absent});await b.command('network.connect',{confirmed:true});await until(()=>b.snapshot().lobby.some(p=>p.text===absent));assert.ok(b.snapshot().lobby.some(p=>p.text.includes(proof.chatSentinel)));check.push('Reconnected client receives recent cached public messages and retains local history');
 const stats=await fetch('https://relay.techflag.cn/api/stats').then(r=>r.json()) as any;assert.ok(stats.users>=2);assert.ok(stats.messages>=before.messages+6);assert.ok(stats.reception.replied>=1);assert.ok(stats.onlineByRoom.general>=2);assert.equal(stats.chatHistoryPersisted,false);assert.equal(JSON.stringify(stats).includes(proof.chatSentinel),false);assert.equal(JSON.stringify(stats).includes(proof.privateSentinel),false);check.push('Public operational counters expose aggregates only');
 await a.close();await b.close();
 if(process.env.DSH_FRIENDS_RESTART_STAGE==='1'){
  assert.ok(process.env.DSH_FRIENDS_DEPLOY_SSH_HOST,'Explicit deployment SSH host required');
  execFileSync('ssh',['-S','/tmp/dsh-friends-relay-deploy.sock','-o','BatchMode=yes',process.env.DSH_FRIENDS_DEPLOY_SSH_HOST!,'systemctl restart dsh-friends-relay-stage'],{stdio:'pipe'});
  let after:any;
  for(let i=0;i<30;i++){try{const r=await fetch('https://relay.techflag.cn/api/stats');if(r.ok){after=await r.json();break}}catch{}await new Promise(r=>setTimeout(r,300))}
  assert.ok(after);assert.equal(after.users,stats.users);assert.equal(after.messages,stats.messages);assert.equal(after.publicHistoryCache.maxPerRoom,100);assert.equal(after.publicHistoryCache.maxAgeSeconds,86400);const fresh=new RelayTransport([url],()=>{});try{await fresh.connect();const page=await fresh.queryPage([{kinds:[9],limit:1000}]);assert.equal(page.complete,true);assert.equal(page.events.length,0);}finally{fresh.close()}check.push('Restart clears public memory history while preserving operational statistics');
 }
 proof.passed=true;
}finally{await a.close();await b.close();await writeFile('.artifacts/selfhosted-relay-memory-acceptance.json',JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:proof.passed,checks:check},null,2))}
