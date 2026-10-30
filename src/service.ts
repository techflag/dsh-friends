import { randomUUID } from 'node:crypto';
import { bech32 } from '@scure/base';
import { z } from 'zod';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, getEventHash, type Event } from 'nostr-tools/pure';
import { encrypt as protect, decrypt as unlock } from 'nostr-tools/nip49';
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44';
import { wrapManyEvents, unwrapEvent } from 'nostr-tools/nip59';
import { RelayTransport } from './relays.js';
import { CANDIDATE_RELAYS, PROFILE_KIND, PROFILE_TAG, LEASE_SECONDS, storedSchema, profileSchema, privateSchema, emptyPrivate, hexKey, FriendsError, demand, type Store, type Stored, type PrivateData, type Peer, type Snapshot, type Outbox } from './model.js';

const eventSchema=z.object({id:hexKey,pubkey:hexKey,created_at:z.number().int().nonnegative(),kind:z.number().int(),tags:z.array(z.array(z.string().max(2048)).max(8)).max(30),content:z.string().max(32_000),sig:z.string().regex(/^[0-9a-f]{128}$/)});
const announcement=z.object({protocol:z.literal('dsh-friends/1'),profile:profileSchema,visible:z.boolean(),expiresAt:z.number().int()}).strict();
const control=z.object({protocol:z.literal('dsh-friends/1'),type:z.enum(['request','accept','text']),id:z.string().uuid(),requestId:z.string().uuid().optional(),expiresAt:z.number().int(),text:z.string().min(1).max(2000)}).strict();
const password=z.string().min(12).max(128).refine(p=>p.trim().length>=12,'Use a longer password');
const now=()=>Math.floor(Date.now()/1000);

export class FriendsService {
  private stored:Stored;
  private secret?:Uint8Array;
  private data?:PrivateData;
  readonly transport:RelayTransport;
  private chain:Promise<unknown>=Promise.resolve();
  private timer?:ReturnType<typeof setInterval>;
  private closed=false;
  private closing=false;
  private receiving=0;
  private maintaining=false;
  private publishedAt=0;
  private lastError?:string;
  constructor(private store:Store, urls:readonly string[]=CANDIDATE_RELAYS){
    this.stored=storedSchema.parse(store.read());
    this.transport=new RelayTransport(urls,event=>{
      if(this.closed||this.closing||this.receiving>=64||!this.secret)return;
      this.receiving++;
      void this.enqueue(()=>this.receive(event)).catch(()=>{this.lastError='收到无法处理的数据，已保留现有数据。';}).finally(()=>this.receiving--);
    });
  }
  private enqueue<T>(run:()=>Promise<T>):Promise<T>{
    if(this.closing)return Promise.reject(new FriendsError('closed','插件正在停止。'));
    const next=this.chain.then(()=>{demand(!this.closed,'closed','插件已停止。');return run();});
    this.chain=next.catch(()=>{});return next;
  }
  private key():Uint8Array {demand(this.secret&&this.data,'locked','请先解锁搭子身份。');return this.secret;}
  private async save(meta:Stored, data=this.data){
    let next:Stored={...meta};
    if(data){
      const text=JSON.stringify(data);
      demand(Buffer.byteLength(text)<4_000_000,'storage-full','本地记录已达到首版容量上限，请先备份。');
      next.encryptedData=encrypt(text,getConversationKey(this.key(),meta.publicKey!));
    }
    await this.store.write(next);this.stored=next;if(data)this.data=data;
  }
  private async change(change:(data:PrivateData)=>void){const next=structuredClone(this.data!);change(next);await this.save(this.stored,next);}
  snapshot():Snapshot {
    const t=now(), data=this.data;
    const peers=data ? Object.values(data.peers).filter(p=>p.visible&&p.expiresAt>t&&!data.blocked.includes(p.publicKey)).sort((a,b)=>b.updatedAt-a.updatedAt) : [];
    return structuredClone({identity:!this.stored.vault?'missing':this.secret?'ready':'locked',publicKey:this.stored.publicKey,profile:this.stored.profile,discoverable:this.stored.discoverable,published:this.publishedAt>t-LEASE_SECONDS,networkApproved:this.stored.networkApproved,relays:[...this.transport.status].map(([url,state])=>({url,state})),peers,invitations:data?Object.values(data.invitations).filter(i=>i.state==='pending'&&i.expiresAt>t&&!data.blocked.includes(i.peer)):[],friends:data?data.friends.map(key=>data.peers[key]??{publicKey:key,name:key.slice(0,12),bio:'',tags:[],looking:'',updatedAt:0,expiresAt:0,visible:false,eventId:''}):[],blocked:data?.blocked??[],messages:data?.messages.filter(m=>!data.blocked.includes(m.peer))??[],pending:data?.outbox.length??0,pendingIds:data?.outbox.map(o=>o.id)??[],...(this.lastError?{error:this.lastError}:{})});
  }
  async command(endpoint:string,payload:unknown):Promise<unknown>{
    return this.enqueue(async()=>{
      if(endpoint==='snapshot')return this.snapshot();
      if(endpoint==='identity.create'){
        const p=z.object({password,profile:profileSchema}).strict().parse(payload);
        demand(!this.stored.vault,'identity-exists','已有身份，请先解锁，不能覆盖。');
        const secret=generateSecretKey();
        try {
          const meta={...this.stored,publicKey:getPublicKey(secret),vault:protect(secret,p.password,16,1),profile:p.profile};
          // Persist the encrypted identity before making the unlocked identity visible.
          await this.store.write(meta);this.stored=meta;this.secret=secret;this.data=emptyPrivate();
        }catch(error){secret.fill(0);throw error;}
        return this.snapshot();
      }
      if(endpoint==='identity.import'){
        const p=z.object({password,vault:z.string().startsWith('ncryptsec1').max(300)}).strict().parse(payload);
        demand(!this.stored.vault,'identity-exists','已有身份，不能直接覆盖。');
        const secret=this.openVault(p.vault,p.password);
        try{const meta={...this.stored,vault:p.vault,publicKey:getPublicKey(secret)};await this.store.write(meta);this.stored=meta;this.secret=secret;this.data=emptyPrivate();}
        catch(error){secret.fill(0);throw error;}
        return this.snapshot();
      }
      if(endpoint==='identity.unlock'){
        const p=z.object({password:z.string().max(128)}).strict().parse(payload);
        demand(this.stored.vault,'identity-missing','尚未创建身份。');
        demand(!this.secret,'already-unlocked','身份已经解锁。');
        const secret=this.openVault(this.stored.vault,p.password);
        try {
          demand(getPublicKey(secret)===this.stored.publicKey,'identity-mismatch','身份记录不一致，已停止读取。');
          let data=emptyPrivate();
          if(this.stored.encryptedData){
            const decoded=JSON.parse(decrypt(this.stored.encryptedData,getConversationKey(secret,this.stored.publicKey!)));
            privateSchema.parse(decoded);data=decoded;
          }
          this.secret=secret;this.data=data;
        }catch{secret.fill(0);throw new FriendsError('storage-unreadable','本地加密记录无法读取，原文件未覆盖。');}
        if(this.stored.networkApproved)await this.connect();
        return this.snapshot();
      }
      this.key();
      if(endpoint==='identity.backup')return {encryptedBackup:this.stored.vault};
      if(endpoint==='identity.lock'){this.stop();return this.snapshot();}
      if(endpoint==='profile.update'){
        const profile=profileSchema.parse(payload);await this.save({...this.stored,profile});
        if(this.stored.discoverable)await this.publishProfile();return this.snapshot();
      }
      if(endpoint==='network.connect'){
        const p=z.object({confirmed:z.literal(true)}).strict().parse(payload);void p;
        await this.save({...this.stored,networkApproved:true});await this.connect();return this.snapshot();
      }
      if(endpoint==='network.disconnect'){
        await this.save({...this.stored,networkApproved:false,discoverable:false});this.transport.close();this.publishedAt=0;return this.snapshot();
      }
      if(endpoint==='discovery.visibility'){
        const p=z.object({visible:z.boolean(),confirmed:z.literal(true)}).strict().parse(payload);
        demand(!p.visible||this.stored.networkApproved,'not-connected','请先开启社区连接。');
        await this.save({...this.stored,discoverable:p.visible});this.publishedAt=0;
        await this.publishProfile();return this.snapshot();
      }
      if(endpoint==='friend.request'){
        const p=z.object({peer:hexKey,text:z.string().trim().min(1).max(120),id:z.string().uuid()}).strict().parse(payload);
        demand(p.peer!==this.stored.publicKey,'self-request','不能添加自己。');
        demand(!this.data!.blocked.includes(p.peer),'blocked','已屏蔽此搭子。');
        demand(!this.data!.friends.includes(p.peer),'already-friend','已经是好友。');
        if(this.data!.invitations[p.id])return this.snapshot();
        demand(!Object.values(this.data!.invitations).some(i=>i.peer===p.peer&&i.state==='pending'&&i.expiresAt>now()),'request-pending','已有待处理邀请。');
        await this.queueControl(p.peer,'request',p.id,p.text);
        await this.flush();return this.snapshot();
      }
      if(endpoint==='friend.accept'||endpoint==='friend.ignore'){
        const p=z.object({id:z.string().uuid()}).strict().parse(payload),invitation=this.data!.invitations[p.id];
        demand(invitation?.direction==='incoming'&&invitation.state==='pending'&&invitation.expiresAt>now(),'request-missing','邀请已失效或已处理。');
        if(endpoint==='friend.accept'){
          demand(this.data!.friends.length<500,'friends-full','好友数量已达到首版容量上限。');
          demand(!this.data!.blocked.includes(invitation.peer),'blocked','已屏蔽此搭子。');
          if(!this.data!.outbox.some(o=>o.type==='accept'&&o.requestId===p.id))await this.queueControl(invitation.peer,'accept',randomUUID(),'接受好友邀请',p.id);
          await this.flush();
          demand(!this.data!.outbox.some(o=>o.type==='accept'&&o.peer===invitation.peer),'accept-pending','接受消息尚未同步，请在连接恢复后重试。');
        }
        if(endpoint==='friend.ignore')await this.change(data=>{data.invitations[p.id].state='ignored';});
        return this.snapshot();
      }
      if(endpoint==='friend.block'){
        const p=z.object({peer:hexKey,blocked:z.boolean()}).strict().parse(payload);
        await this.change(data=>{data.blocked=data.blocked.filter(k=>k!==p.peer);if(p.blocked)data.blocked.push(p.peer);data.outbox=data.outbox.filter(o=>o.peer!==p.peer);});return this.snapshot();
      }
      if(endpoint==='message.send'){
        const p=z.object({peer:hexKey,text:z.string().trim().min(1).max(2000),id:z.string().uuid()}).strict().parse(payload);
        demand(this.data!.friends.includes(p.peer),'not-friends','需要双方确认好友邀请后才能聊天。');
        demand(!this.data!.blocked.includes(p.peer),'blocked','已屏蔽此搭子。');
        if(this.data!.messages.some(m=>m.id===p.id))return this.snapshot();
        await this.queueControl(p.peer,'text',p.id,p.text);
        await this.flush();return this.snapshot();
      }
      if(endpoint==='message.retry'){z.object({}).strict().parse(payload);await this.flush();return this.snapshot();}
      throw new FriendsError('unknown-command','此操作尚未支持。');
    });
  }
  private openVault(vault:string,passphrase:string){
    // NIP-49 embeds its scrypt cost. Reject hostile work factors before decryption.
    demand(/^ncryptsec1/.test(vault)&&vault.length<300,'invalid-backup','备份格式无效。');
    try{
      const decoded=bech32.decode(vault as `ncryptsec1${string}`,300),bytes=bech32.fromWords(decoded.words);
      demand(decoded.prefix==='ncryptsec'&&bytes.length===91&&bytes[0]===2&&bytes[1]>=16&&bytes[1]<=18,'backup-cost','此备份的格式或计算成本不受支持。');
      return unlock(vault,passphrase);
    }catch(error){if(error instanceof FriendsError)throw error;throw new FriendsError('unlock-failed','口令错误或备份无效，原有数据未改动。');}
  }
  private async connect(){
    await this.transport.connect(this.stored.publicKey!);
    if(![...this.transport.status.values()].includes('connected')){this.lastError='所有社区中继均连接失败；资料与消息保留在本机。';return;}
    this.lastError=undefined;
    if(this.stored.discoverable)await this.publishProfile();
    await this.flush();
    if(!this.timer)this.timer=setInterval(()=>{
      if(!this.secret||!this.stored.networkApproved||this.closed||this.closing||this.maintaining)return;
      this.maintaining=true;
      void this.enqueue(async()=>{
        await this.transport.connect(this.stored.publicKey!);
        if(this.stored.discoverable&&this.publishedAt<now()-300)await this.publishProfile();
        await this.flush();
      }).catch(()=>{this.lastError='社区连接暂不可用，可到设置重新连接。';}).finally(()=>{this.maintaining=false;});
    },5_000);
  }
  private async publishProfile(){
    const t=Math.max(now(),this.stored.announcementAt+1);
    demand(t<=now()+300,'too-many-updates','名片更新过于频繁，请稍后再试。');
    await this.save({...this.stored,announcementAt:t});
    const profile=finalizeEvent({kind:PROFILE_KIND,created_at:t,tags:[['d',PROFILE_TAG]],content:JSON.stringify({protocol:'dsh-friends/1',profile:this.stored.profile,visible:this.stored.discoverable,expiresAt:t+LEASE_SECONDS})},this.key());
    const accepted=await this.transport.publish(profile);
    if(!accepted.length){this.lastError=this.stored.discoverable?'名片尚未被任何中继确认接收，请重试。':'已停止发布；旧名片会随活动租约失效。';return;}
    this.publishedAt=this.stored.discoverable?t:0;
    const inbox=finalizeEvent({kind:10050,created_at:t,tags:accepted.map(url=>['relay',url]),content:''},this.key());
    const inboxAccepted=await this.transport.publish(inbox);
    if(inboxAccepted.length)await this.save({...this.stored,inboxUrls:accepted});
    this.lastError=inboxAccepted.length?undefined:'名片已发布，但私信接收配置尚未同步。';
  }
  private async recipientRelays(peer:string){
    const cached=this.data!.inboxes[peer];
    if(![...this.transport.status.values()].includes('connected')){
      if(cached&&cached.updatedAt>now()-86400&&cached.urls.length)return cached.urls;
      throw new FriendsError('offline','社区连接已断开，内容保留在输入框中，请连接后重试。');
    }
    const events=await this.transport.query([{kinds:[10050],authors:[peer],limit:1}]);
    const latest=events.filter(e=>e.pubkey===peer&&e.kind===10050&&e.created_at<=now()+300&&verifyEvent(e)).sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id))[0];
    const advertised=new Set<string>();
    for(const tag of latest?.tags??[]){if(tag[0]!=='relay')continue;try{advertised.add(new URL(tag[1]).href);}catch{}}
    const urls=this.transport.urls.filter(url=>advertised.has(new URL(url).href));
    if(latest)await this.change(data=>{data.inboxes[peer]={urls,updatedAt:now()};});
    demand(urls.length,'recipient-not-ready','对方尚未配置你已允许连接的私信中继，请稍后重试。');return urls;
  }
  private async queueControl(peer:string,type:Outbox['type'],id:string,text:string,requestId?:string){
    demand(this.stored.networkApproved,'not-connected','请先在设置中开启社区连接。');
    demand(this.data!.outbox.length<100,'queue-full','待发消息较多，请恢复连接后重试。');
    const relayUrls=await this.recipientRelays(peer);
    const content=JSON.stringify({protocol:'dsh-friends/1',type,id,text,expiresAt:now()+7*86400,...(requestId?{requestId}:{})});
    const events=wrapManyEvents({kind:14,created_at:now(),tags:[['p',peer]],content},this.key(),[peer]);
    await this.change(data=>{
      if(data.outbox.some(o=>o.id===id))return;
      data.outbox.push({id,peer,type,relayUrls,events:events as unknown as Record<string,unknown>[],...(requestId?{requestId}:{})});
      if(type==='request'){
        demand(Object.keys(data.invitations).length<500,'invitations-full','邀请记录已达到首版容量上限。');
        data.invitations[id]={id,peer,greeting:text,direction:'outgoing',state:'pending',expiresAt:now()+7*86400};
      }
      if(type==='text'){
        demand(data.messages.length<1000,'storage-full','消息已达到首版容量上限，请先备份。');
        data.messages.push({id,peer,text,mine:true,createdAt:now(),status:'sending'});
      }
    });
  }
  private async flush(){
    if(!this.stored.networkApproved||!this.secret)return;
    const batchStarted=Date.now();
    for(const item of this.data!.outbox.slice(0,3)){
      if(Date.now()-batchStarted>5000)break;
      if(this.data!.blocked.includes(item.peer))continue;
      // Only recipient-directed wraps count toward the peer-delivery claim.
      const wrap=item.events.find(e=>(e.tags as string[][]).some(t=>t[0]==='p'&&t[1]===item.peer)) as unknown as Event;
      let routes=item.relayUrls;
      if([...this.transport.status.values()].includes('connected')){
        try{routes=await this.recipientRelays(item.peer);}catch{routes=[];this.lastError='部分待发消息的收件配置尚未准备好，已保留待发记录。';}
      }
      const accepted=await this.transport.publish(wrap,routes);
      if(accepted.length){
        await this.change(data=>{
          data.outbox=data.outbox.filter(o=>o.id!==item.id);
          const message=data.messages.find(m=>m.id===item.id);if(message)message.status='relay-accepted';
          if(item.type==='accept'&&item.requestId){
            for(const invitation of Object.values(data.invitations))if(invitation.peer===item.peer&&invitation.state==='pending')invitation.state='accepted';
            if(!data.friends.includes(item.peer))data.friends.push(item.peer);
          }
        });
        // The sender's encrypted copy is best effort, never a delivery receipt.
        for(const own of item.events.filter(e=>e!==wrap))await this.transport.publish(own as unknown as Event,this.stored.inboxUrls);
      }else await this.change(data=>{const message=data.messages.find(m=>m.id===item.id);if(message)message.status='failed';});
    }
  }
  private async receive(candidate:Event){
    const parsed=eventSchema.safeParse(candidate);if(!parsed.success)return;
    const event=parsed.data;
    if(!verifyEvent(event)||event.pubkey===this.stored.publicKey)return;
    if(event.kind===PROFILE_KIND){
      if(event.created_at>now()+300||!event.tags.some(t=>t[0]==='d'&&t[1]===PROFILE_TAG))return;
      let value;try{value=announcement.parse(JSON.parse(event.content));}catch{return;}
      if(value.expiresAt<=now()||value.expiresAt>event.created_at+LEASE_SECONDS)return;
      const old=this.data!.peers[event.pubkey];
      if(old&&(old.updatedAt>event.created_at||(old.updatedAt===event.created_at&&old.eventId<=event.id)))return;
      if(!old&&Object.keys(this.data!.peers).length>=500)return;
      await this.change(data=>{data.peers[event.pubkey]={...value.profile,publicKey:event.pubkey,updatedAt:event.created_at,expiresAt:value.expiresAt,visible:value.visible,eventId:event.id};});return;
    }
    if(event.kind!==1059||!event.tags.some(t=>t[0]==='p'&&t[1]===this.stored.publicKey))return;
    let rumor;try{rumor=unwrapEvent(event,this.key());}catch{return;}
    if(rumor.kind!==14||rumor.id!==getEventHash(rumor)||rumor.created_at>now()+300||!rumor.tags.some(t=>t[0]==='p'&&t[1]===this.stored.publicKey))return;
    const peer=rumor.pubkey;
    if(peer===this.stored.publicKey)return;
    let value;try{value=control.parse(JSON.parse(rumor.content));}catch{return;}
    if(value.expiresAt<now()||value.expiresAt>rumor.created_at+7*86400||this.data!.seen.includes(`${peer}:${value.id}`))return;
    if(this.data!.blocked.includes(peer)){
      await this.change(data=>{data.seen=[...data.seen,`${peer}:${value.id}`].slice(-2000);});return;
    }
    await this.change(data=>{
      const pending=Object.values(data.invitations).filter(i=>i.peer===peer&&i.state==='pending'&&i.expiresAt>now());
      if(value.type==='request'){
        if(data.friends.includes(peer)||pending.some(i=>i.direction==='incoming')||Object.keys(data.invitations).length>=500)return;
        if(data.invitations[value.id]&&data.invitations[value.id].peer!==peer)return;
        data.invitations[value.id]={id:value.id,peer,greeting:value.text.slice(0,120),direction:'incoming',state:'pending',expiresAt:value.expiresAt};
      }else if(value.type==='accept'){
        if(data.friends.length>=500)return;
        const invitation=value.requestId?data.invitations[value.requestId]:undefined;
        if(!invitation||invitation.peer!==peer||invitation.direction!=='outgoing'||invitation.state!=='pending'||invitation.expiresAt<now())return;
        for(const row of Object.values(data.invitations))if(row.peer===peer&&row.state==='pending')row.state='accepted';
        if(!data.friends.includes(peer))data.friends.push(peer);
      }else if(value.type==='text'){
        if(!data.friends.includes(peer)||data.messages.length>=1000)return;
        data.messages.push({id:value.id,peer,text:value.text,mine:false,createdAt:rumor.created_at,status:'received'});
      }
      data.seen.push(`${peer}:${value.id}`);data.seen=data.seen.slice(-2000);
    });
  }
  private stop(){
    if(this.timer)clearInterval(this.timer);this.timer=undefined;
    this.transport.close();this.secret?.fill(0);this.secret=undefined;this.data=undefined;this.publishedAt=0;
  }
  async close(){this.closing=true;if(this.timer)clearInterval(this.timer);this.transport.close();await this.chain;this.stop();this.closed=true;}
}
