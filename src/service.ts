import type { MessageNotice } from './notifications.js';
import { PLUGIN_VERSION, PLUGIN_REVISION } from './version.js';
import type {LocalIdentityStore} from './local-identity.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { bech32 } from '@scure/base';
import { z } from 'zod';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, getEventHash, type Event } from 'nostr-tools/pure';
import { encrypt as protect, decrypt as unlock } from 'nostr-tools/nip49';
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44';
import { wrapManyEvents, unwrapEvent } from 'nostr-tools/nip59';
import { RelayTransport } from './relays.js';
import { CANDIDATE_RELAYS, PROFILE_KIND, PROFILE_TAG, LEASE_SECONDS, LOBBY_KIND, LOBBY_TAG, LOBBY_LIMIT, PRESENCE_KIND, PRESENCE_SNAPSHOT_KIND, ROOMS, eventRoom, roomIdSchema, publicEventSchema, type RoomId, storedSchema, profileSchema, privateSchema, emptyPrivate, hexKey, FriendsError, demand, type Store, type Stored, type PrivateData, type Peer, type Snapshot, type Outbox, type RoomEntry } from './model.js';

const eventSchema=z.object({id:hexKey,pubkey:hexKey,created_at:z.number().int().nonnegative(),kind:z.number().int(),tags:z.array(z.array(z.string().max(2048)).max(8)).max(30),content:z.string().max(32_000),sig:z.string().regex(/^[0-9a-f]{128}$/)});
const announcement=z.object({protocol:z.literal('dsh-friends/1'),profile:profileSchema,visible:z.boolean(),expiresAt:z.number().int()}).strict();
const control=z.object({protocol:z.literal('dsh-friends/1'),type:z.enum(['request','accept','text']),id:z.string().uuid(),requestId:z.string().uuid().optional(),expiresAt:z.number().int(),text:z.string().min(1).max(2000)}).strict();
const password=z.string().min(12).max(128).refine(p=>p.trim().length>=12,'Use a longer password');
const presencePayload=z.object({protocol:z.literal('dsh-friends/presence/1'),action:z.enum(['join','heartbeat','leave']),name:z.string().trim().min(1).max(20)}).strict();
const presenceSnapshot=z.object({protocol:z.literal('dsh-friends/presence-snapshot/1'),rooms:z.record(roomIdSchema,z.number().int().nonnegative().max(100000))}).strict();
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
  private inboxPublishedAt=0;
  private lastError?:string;
  private publicEvents=new Map<string,Event>();
  private roomHistory:Record<RoomId,{until?:number;exhausted:boolean;loaded:boolean}>={general:{exhausted:false,loaded:false},builders:{exhausted:false,loaded:false},random:{exhausted:false,loaded:false}};
  private notices:MessageNotice[]=[];
  private noticeRevision=0;
  private noticeWaiters=new Set<()=>void>();
  private noticeBatch(){return {revision:this.noticeRevision,enabled:this.stored.notificationsEnabled&&this.stored.networkApproved&&!this.closing,entryEnabled:this.stored.entryNotificationsEnabled&&this.stored.networkApproved&&!this.closing,items:structuredClone(this.notices)};}
  private wakeNotices(){this.noticeRevision++;for(const wake of [...this.noticeWaiters])wake();}
  private addNotice(notice:MessageNotice){this.notices=[...this.notices,notice].slice(-100);this.wakeNotices();}
  private guestBlocked=new Set<string>();
  private roomOnline:Record<RoomId,number>={general:0,builders:0,random:0};
  private roomEntries:RoomEntry[]=[];
  private presenceRoom?:RoomId;
  private presenceAt=0;
  constructor(private store:Store, urls:readonly string[]=CANDIDATE_RELAYS,private protectedIdentity?:LocalIdentityStore){
    this.stored=storedSchema.parse(store.read());
    for(const event of this.stored.publicHistory)if(this.validPublic(event))this.publicEvents.set(event.id,event);
    this.transport=new RelayTransport(urls,(event,live)=>{
      if(this.closed||this.closing||this.receiving>=512||(!this.secret&&event.kind!==LOBBY_KIND))return;
      this.receiving++;
      void this.enqueue(()=>this.receive(event,live)).catch(()=>{this.lastError='收到无法处理的数据，已保留现有数据。';}).finally(()=>this.receiving--);
    },async event=>{
      demand(this.stored.networkApproved&&this.secret,'auth-not-approved','请先解锁身份并同意连接。');
      const relay=event.tags.filter(t=>t[0]==='relay'),challenge=event.tags.filter(t=>t[0]==='challenge');
      demand(event.kind===22242&&event.content===''&&relay.length===1&&challenge.length===1&&challenge[0][1]?.length<=1024&&urls.some(url=>new URL(url).href===new URL(relay[0][1]).href)&&Math.abs(event.created_at-now())<60,'invalid-auth','中继身份验证请求无效。');
      return finalizeEvent(event,this.key());
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
    const publicEvents=new Map(this.publicEvents);
    for(const operation of data?.lobbyQueue??[])publicEvents.set(operation.event.id,operation.event);
    const lobby=[...publicEvents.values()].filter(e=>!data?.blocked.includes(e.pubkey)&&!this.guestBlocked.has(e.pubkey)).sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id)).map(e=>{
      const operation=data?.lobbyQueue.find(o=>o.event.id===e.id);
      return {id:e.id,room:eventRoom(e),publicKey:e.pubkey,name:e.tags.find(t=>t[0]==='name')?.[1]?.slice(0,20)||e.pubkey.slice(0,12),text:e.content,createdAt:e.created_at,assistant:Boolean(e.tags.find(t=>t[0]==='bot'&&t[1]==='reception')),...(e.tags.find(t=>t[0]==='q')?.[1]?{replyTo:e.tags.find(t=>t[0]==='q')![1]}:{}),...(operation?{status:operation.status,acceptedRelays:operation.acceptedRelays}:{})};
    });
    const peers=data ? Object.values(data.peers).filter(p=>p.visible&&p.expiresAt>t&&!data.blocked.includes(p.publicKey)).sort((a,b)=>b.updatedAt-a.updatedAt) : [];
    return structuredClone({runtimeVersion:PLUGIN_VERSION,runtimeRevision:PLUGIN_REVISION,historyPolicy:this.transport.urls.length>0&&this.transport.urls.every(url=>new URL(url).hostname==='relay.techflag.cn')?'memory-24h':'relay-defined',identity:!this.stored.vault?'missing':this.secret?'ready':'locked',publicKey:this.stored.publicKey,profile:this.stored.profile,discoverable:this.stored.discoverable,published:this.publishedAt>t-LEASE_SECONDS,networkApproved:this.stored.networkApproved,relays:[...this.transport.status].map(([url,state])=>({url,state,privateState:this.transport.privateStatus.get(url),route:this.transport.routes.get(url),...(this.transport.details.get(url)?{detail:this.transport.details.get(url)}:{})})),peers,invitations:data?Object.values(data.invitations).filter(i=>i.state==='pending'&&i.expiresAt>t&&!data.blocked.includes(i.peer)):[],friends:data?data.friends.map(key=>data.peers[key]??{publicKey:key,name:key.slice(0,12),bio:'',tags:[],looking:'',updatedAt:0,expiresAt:0,visible:false,eventId:''}):[],blocked:[...new Set([...(data?.blocked??[]),...this.guestBlocked])],messages:data?.messages.filter(m=>!data.blocked.includes(m.peer))??[],lobby,localIdentity:Boolean(this.stored.localIdentityId),notificationsEnabled:this.stored.notificationsEnabled,entryNotificationsEnabled:this.stored.entryNotificationsEnabled,selectedRoom:this.stored.selectedRoom,roomOnline:this.roomOnline,roomEntries:this.roomEntries.filter(entry=>entry.createdAt>t-300).slice(-20),roomHistory:this.roomHistory,pending:(data?.outbox.length??0)+(data?.lobbyQueue.filter(o=>o.status!=='relay-accepted').length??0),pendingIds:[...(data?.outbox.map(o=>o.id)??[]),...(data?.lobbyQueue.filter(o=>o.status!=='relay-accepted').map(o=>o.id)??[])],...(this.lastError?{error:this.lastError}:{})});
  }
  async command(endpoint:string,payload:unknown,signal?:AbortSignal):Promise<unknown>{
    if(endpoint==='notifications.wait'){
      const {after}=z.object({after:z.number().int().nonnegative()}).strict().parse(payload);
      demand(this.noticeWaiters.size<32,'too-many-watchers','提醒连接较多，请稍后重试。');
      if(after!==this.noticeRevision||this.closing||signal?.aborted)return this.noticeBatch();
      // Waiting must never hold the serialized command queue or block message delivery.
      return new Promise(resolve=>{
        const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);this.noticeWaiters.delete(finish);resolve(this.noticeBatch());};
        const timer=setTimeout(finish,25000);this.noticeWaiters.add(finish);signal?.addEventListener('abort',finish,{once:true});
        if(signal?.aborted)finish();
      });
    }
    return this.enqueue(async()=>{
      if(endpoint==='snapshot')return this.snapshot();
      if(endpoint==='identity.local'){
        z.object({}).strict().parse(payload);
        if(this.secret&&this.stored.localIdentityId)return this.snapshot();
        demand(this.protectedIdentity,'local-identity-unavailable','这台设备暂不支持自动保存发言身份。你仍可浏览聊天室和历史。');
        demand(!this.stored.vault||this.stored.localIdentityId||this.secret,'legacy-identity','检测到旧版加密身份，已保留原记录。可在“我”中选择旧版身份恢复；不会另建身份覆盖。');
        const id=this.stored.localIdentityId??randomUUID();
        let pass:string|undefined;
        try{pass=await this.protectedIdentity.read(id);}catch{throw new FriendsError('local-identity-unavailable','本机安全存储暂不可用，请稍后重试。仍可查看聊天历史。');}
        if(this.stored.localIdentityId){
          demand(pass&&this.stored.vault,'local-identity-missing','本机身份的安全记录暂不可用，原有数据未修改。');
          const secret=this.openVault(this.stored.vault,pass);
          try{demand(getPublicKey(secret)===this.stored.publicKey,'identity-mismatch','本机身份不一致。');const data=this.stored.encryptedData?privateSchema.parse(JSON.parse(decrypt(this.stored.encryptedData,getConversationKey(secret,this.stored.publicKey!)))):emptyPrivate();this.secret=secret;this.data=data;}catch{secret.fill(0);throw new FriendsError('storage-unreadable','原有记录暂时无法读取，未覆盖数据。');}
        }else{
          pass=randomBytes(48).toString('hex');const secret=this.secret??generateSecretKey(),owned=!this.secret;
          try{
            await this.protectedIdentity.write(id,pass);
            const publicKey=getPublicKey(secret),meta={...this.stored,localIdentityId:id,publicKey,vault:protect(secret,pass,16,1),profile:this.stored.profile.name==='新搭子'?{...this.stored.profile,name:'搭子'+publicKey.slice(0,4)}:this.stored.profile};
            await this.store.write(meta);this.stored=meta;this.secret=secret;this.data??=emptyPrivate();
          }catch{if(owned)secret.fill(0);try{await this.protectedIdentity.remove(id);}catch{}throw new FriendsError('local-identity-unavailable','本机身份未能安全保存，请稍后重试。原有记录未覆盖。');}
        }
        if(this.stored.networkApproved)await this.connect();return this.snapshot();
      }
      if(endpoint==='identity.create'){
        const p=z.object({password,profile:profileSchema}).strict().parse(payload);
        demand(!this.stored.vault,'identity-exists','已有身份，请先解锁，不能覆盖。');
        const secret=generateSecretKey();
        try {
          const meta={...this.stored,publicKey:getPublicKey(secret),vault:protect(secret,p.password,16,1),profile:p.profile};
          // Persist the encrypted identity before making the unlocked identity visible.
          await this.store.write(meta);this.stored=meta;this.secret=secret;this.data=emptyPrivate();
        }catch(error){secret.fill(0);throw error;}
        if(this.stored.networkApproved)await this.connect();
        return this.snapshot();
      }
      if(endpoint==='identity.import'){
        const p=z.object({password,vault:z.string().startsWith('ncryptsec1').max(300)}).strict().parse(payload);
        demand(!this.stored.vault,'identity-exists','已有身份，不能直接覆盖。');
        const secret=this.openVault(p.vault,p.password);
        try{const meta={...this.stored,vault:p.vault,publicKey:getPublicKey(secret)};await this.store.write(meta);this.stored=meta;this.secret=secret;this.data=emptyPrivate();}
        catch(error){secret.fill(0);throw error;}
        if(this.stored.networkApproved)await this.connect();
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
            data=privateSchema.parse(decoded);
          }
          this.secret=secret;this.data=data;
        }catch{secret.fill(0);throw new FriendsError('storage-unreadable','本地加密记录无法读取，原文件未覆盖。');}
        if(this.stored.networkApproved)await this.connect();
        return this.snapshot();
      }
      if(endpoint==='network.connect'){
        const p=z.object({confirmed:z.literal(true)}).strict().parse(payload);void p;
        await this.save({...this.stored,networkApproved:true});await this.connect();return this.snapshot();
      }
      if(endpoint==='network.disconnect'){
        await this.save({...this.stored,networkApproved:false,discoverable:false});this.transport.close();this.publishedAt=0;this.wakeNotices();return this.snapshot();
      }
      if(endpoint==='friend.block'&&!this.secret){const p=z.object({peer:hexKey,blocked:z.boolean()}).strict().parse(payload);if(p.blocked)this.guestBlocked.add(p.peer);else this.guestBlocked.delete(p.peer);return this.snapshot();}
      if(endpoint==='notifications.poll')return this.noticeBatch();
      if(endpoint==='notifications.set'){
        const p=z.object({enabled:z.boolean()}).strict().parse(payload);await this.save({...this.stored,notificationsEnabled:p.enabled});this.wakeNotices();return this.snapshot();
      }
      if(endpoint==='notifications.entry.set'){
        const p=z.object({enabled:z.boolean()}).strict().parse(payload);await this.save({...this.stored,entryNotificationsEnabled:p.enabled});this.wakeNotices();return this.snapshot();
      }
      if(endpoint==='room.select'){
        const p=z.object({room:roomIdSchema}).strict().parse(payload);
        const old=this.stored.selectedRoom;
        await this.save({...this.stored,selectedRoom:p.room});
        if(this.secret&&this.stored.networkApproved){if(old!==p.room)await this.publishPresence('leave',old);await this.publishPresence('join',p.room);}
        return this.snapshot();
      }
      if(endpoint==='lobby.history'){
        const p=z.object({room:roomIdSchema}).strict().parse(payload);
        await this.loadHistory(p.room);return this.snapshot();
      }
      this.key();
      if(endpoint==='identity.backup'){demand(!this.stored.localIdentityId,'local-backup-unavailable','本机自动身份暂不提供跨设备备份导出。');return {encryptedBackup:this.stored.vault};}
      if(endpoint==='identity.lock'){this.stop();if(this.stored.networkApproved)await this.connect();return this.snapshot();}
      if(endpoint==='lobby.send'){
        const p=z.object({id:z.string().uuid(),text:z.string().trim().min(1).max(2000),replyTo:hexKey.optional(),room:roomIdSchema.default('general'),confirmed:z.literal(true)}).strict().parse(payload);
        demand(this.stored.networkApproved,'not-connected','请先连接大厅，草稿保留在输入框中。');
        const prior=this.data!.lobbyQueue.find(o=>o.id===p.id);
        if(prior){demand(eventRoom(prior.event)===p.room&&prior.event.content===p.text&&prior.event.tags.find(t=>t[0]==='q')?.[1]===p.replyTo,'operation-conflict','同一次发言的内容不一致，请刷新后重试。');await this.flushLobby();return this.snapshot();}
        demand(this.data!.lobbyQueue.filter(o=>o.status!=='relay-accepted').length<50,'queue-full','待发公开消息较多，请连接后重试。');
        demand(this.data!.lobbyQueue.filter(o=>o.event.created_at>now()-60).length<20,'rate-limited','发言较频繁，请稍后再试。');
        const tags=[['t',ROOMS.find(r=>r.id===p.room)!.tag],['name',this.stored.profile.name],['dsh-id',p.id]];
        if(p.replyTo){const parent=this.publicEvents.get(p.replyTo)??this.data!.lobbyQueue.find(o=>o.event.id===p.replyTo)?.event;demand(parent&&eventRoom(parent)===p.room,'reply-missing','原消息已不在当前记录中，请取消回复后重新发言。');tags.push(['q',parent.id,this.transport.urls[0]??'',parent.pubkey]);}
        const event=finalizeEvent({kind:LOBBY_KIND,created_at:now(),tags,content:p.text},this.key());
        await this.change(data=>{data.lobbyQueue=data.lobbyQueue.filter(o=>o.status!=='relay-accepted'||o.event.created_at>now()-30*86400);if(data.lobbyQueue.length>=LOBBY_LIMIT){const index=data.lobbyQueue.findIndex(o=>o.status==='relay-accepted');demand(index>=0,'queue-full','公开消息队列已满。');data.lobbyQueue.splice(index,1);}data.lobbyQueue.push({id:p.id,event,status:'sending',acceptedRelays:[]});});
        await this.flushLobby();
        if(this.data!.lobbyQueue.find(o=>o.id===p.id)?.status==='relay-accepted'&&!this.stored.inboxUrls.length)await this.publishInbox();
        return this.snapshot();
      }
      if(endpoint==='lobby.retry'){z.object({}).strict().parse(payload);await this.flushLobby();return this.snapshot();}
      if(endpoint==='profile.update'){
        const profile=profileSchema.parse(payload);await this.save({...this.stored,profile});
        if(this.stored.discoverable)await this.publishProfile();return this.snapshot();
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
        await this.publishInbox();
        await this.queueControl(p.peer,'request',p.id,p.text);
        await this.flushLobby();await this.flush();return this.snapshot();
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
      if(endpoint==='message.retry'){z.object({}).strict().parse(payload);await this.flushLobby();await this.flush();return this.snapshot();}
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
  async start(){if(this.stored.localIdentityId&&this.protectedIdentity){try{await this.command('identity.local',{});return;}catch{this.lastError='本机安全身份暂未恢复，仍可查看公开聊天记录。';}}if(this.stored.networkApproved)await this.enqueue(()=>this.connect());}
  private async connect(){
    await this.transport.connect(this.secret?this.stored.publicKey:undefined);
    if(!this.timer)this.timer=setInterval(()=>{
      if(!this.stored.networkApproved||this.closed||this.closing||this.maintaining)return;
      this.maintaining=true;
      void this.enqueue(async()=>{
        const wasConnected=[...this.transport.status.values()].includes('connected');
        await this.transport.connect(this.secret?this.stored.publicKey:undefined);
        if([...this.transport.status.values()].includes('connected')&&this.lastError?.startsWith('所有社区中继'))this.lastError=undefined;
        if(this.secret&&this.stored.discoverable&&this.publishedAt<now()-300)await this.publishProfile();
        if(this.secret&&this.stored.inboxUrls.length&&(!wasConnected||this.inboxPublishedAt<now()-60))await this.publishInbox();
        if(this.secret&&(!wasConnected||this.presenceRoom!==this.stored.selectedRoom||this.presenceAt<now()-45))await this.publishPresence(wasConnected?'heartbeat':'join',this.stored.selectedRoom);
        await this.flushLobby();await this.flush();
      }).catch(()=>{this.lastError='社区连接暂不可用，可到设置重新连接。';}).finally(()=>{this.maintaining=false;});
    },5_000);
    if(![...this.transport.status.values()].includes('connected')){this.lastError='所有社区中继均连接失败；会自动重试，资料与消息保留在本机。';return;}
    this.lastError=undefined;
    if(this.secret&&this.stored.discoverable)await this.publishProfile();
    else if(this.secret&&this.stored.inboxUrls.length)await this.publishInbox();
    if(this.secret)await this.publishPresence('join',this.stored.selectedRoom);
    await this.flushLobby();await this.flush();
  }
  private async publishPresence(action:'join'|'heartbeat'|'leave',room:RoomId){
    if(!this.secret||!this.stored.networkApproved||![...this.transport.status.values()].includes('connected'))return;
    const event=finalizeEvent({kind:PRESENCE_KIND,created_at:now(),tags:[['t',ROOMS.find(r=>r.id===room)!.tag],['expiration',String(now()+90)]],content:JSON.stringify({protocol:'dsh-friends/presence/1',action,name:this.stored.profile.name})},this.key());
    if((await this.transport.publish(event)).length){this.presenceRoom=action==='leave'?undefined:room;this.presenceAt=now();}
  }
  private async publishInbox(){
    const urls=this.transport.urls.filter(url=>this.transport.status.get(url)==='connected');
    if(!urls.length)return;
    const t=Math.max(now(),this.stored.announcementAt+1);if(t>now()+300)return;
    await this.save({...this.stored,announcementAt:t});
    const event=finalizeEvent({kind:10050,created_at:t,tags:urls.map(url=>['relay',url]),content:''},this.key());
    if((await this.transport.publish(event)).length){await this.save({...this.stored,inboxUrls:urls});this.inboxPublishedAt=now();}
    else this.lastError='公开发言已发出，私聊接收配置尚未准备好。';
  }
  private async flushLobby(){
    if(!this.secret||!this.stored.networkApproved)return;
    for(const item of this.data!.lobbyQueue.filter(o=>o.status!=='relay-accepted').slice(0,2)){
      const accepted=await this.transport.publish(item.event);
      await this.change(data=>{const row=data.lobbyQueue.find(o=>o.id===item.id);if(row){row.status=accepted.length?'relay-accepted':'failed';row.acceptedRelays=accepted;}});
      if(!accepted.length)this.lastError='公开发言尚未被中继确认，已保留在本机，可重试。';
      else if(this.lastError?.startsWith('公开发言'))this.lastError=undefined;
    }
    if(!this.stored.inboxUrls.length&&this.data!.lobbyQueue.some(o=>o.status==='relay-accepted'))await this.publishInbox();
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
    if(inboxAccepted.length){await this.save({...this.stored,inboxUrls:accepted});this.inboxPublishedAt=now();}
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
  private knownPublicPeer(key:string):Peer|undefined{const event=[...this.publicEvents.values()].filter(e=>e.pubkey===key).sort((a,b)=>b.created_at-a.created_at)[0];return event?{publicKey:key,name:event.tags.find(t=>t[0]==='name')?.[1]?.trim().slice(0,20)||key.slice(0,12),bio:'',tags:[],looking:'',updatedAt:0,expiresAt:0,visible:false,eventId:event.id}:undefined;}
  private async queueControl(peer:string,type:Outbox['type'],id:string,text:string,requestId?:string){
    demand(this.stored.networkApproved,'not-connected','请先在设置中开启社区连接。');
    demand(this.data!.outbox.length<100,'queue-full','待发消息较多，请恢复连接后重试。');
    const relayUrls=await this.recipientRelays(peer);
    const content=JSON.stringify({protocol:'dsh-friends/1',type,id,text,expiresAt:now()+7*86400,...(requestId?{requestId}:{})});
    const events=wrapManyEvents({kind:14,created_at:now(),tags:[['p',peer]],content},this.key(),[peer]);
    await this.change(data=>{
      if(data.outbox.some(o=>o.id===id))return;
      if(!data.peers[peer]){const known=this.knownPublicPeer(peer);if(known&&Object.keys(data.peers).length<500)data.peers[peer]=known;}
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
  private validPublic(event:Event):boolean {
    if(!eventSchema.safeParse(event).success||!verifyEvent(event)||event.kind!==LOBBY_KIND||!eventRoom(event)||event.created_at>now()+300||!event.content.trim()||event.content.length>2000)return false;
    const expires=event.tags.find(t=>t[0]==='expiration')?.[1];
    const quote=event.tags.find(t=>t[0]==='q');
    return !(expires!==undefined&&(!/^\d+$/.test(expires)||Number(expires)<=now()))&&(!quote||hexKey.safeParse(quote[1]).success);
  }
  private insertPublic(event:Event){
    this.publicEvents.set(event.id,event);
    const room=eventRoom(event),events=[...this.publicEvents.values()].filter(e=>eventRoom(e)===room).sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id));
    if(events.length>LOBBY_LIMIT)this.publicEvents.delete(events[0].id);
  }
  private async cachePublic(){
    const publicHistory=ROOMS.flatMap(room=>[...this.publicEvents.values()].filter(e=>eventRoom(e)===room.id).sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id)).slice(0,300));
    // Public messages only. Never place identity secrets or private messages in this cache.
    const next={...this.stored,publicHistory:publicHistory.map(event=>publicEventSchema.parse(event))};await this.store.write(next);this.stored=next;
  }
  private async loadHistory(room:RoomId){
    demand(this.stored.networkApproved,'not-connected','请先连接社区；已缓存的记录仍可查看。');
    const state=this.roomHistory[room];if(state.exhausted)return;
    demand([...this.publicEvents.values()].filter(e=>eventRoom(e)===room).length<LOBBY_LIMIT,'history-limit','本轮已加载 1000 条，请重新打开插件后继续查看近期记录。');
    const tag=ROOMS.find(r=>r.id===room)!.tag;
    const page=await this.transport.queryPage([{kinds:[LOBBY_KIND],'#t':[tag],until:state.until??now()+300,limit:50}]);
    demand(page.complete,'history-incomplete','历史查询未完成，请重试；没有跳过任何历史。');
    const valid=page.events.filter(e=>eventRoom(e)===room&&this.validPublic(e)&&e.created_at<=(state.until??now()+300));
    if(!valid.length){
      demand(!page.events.length,'history-invalid','中继返回的历史无法验证，请更换连接或重试。');
      state.loaded=true;state.exhausted=true;return;
    }
    const oldest=Math.min(...valid.map(e=>e.created_at));
    // until is inclusive. Fetch the whole boundary second before advancing it.
    // Never skip same-second messages by using timestamp-1 on a partial batch.
    const boundary=await this.transport.queryPage([{kinds:[LOBBY_KIND],'#t':[tag],since:oldest,until:oldest,limit:1001}]);
    demand(boundary.complete&&!boundary.saturated,'history-boundary','同一秒的历史过多或查询未完成，暂不能安全翻页；请重试。');
    const merged=[...valid,...boundary.events.filter(e=>eventRoom(e)===room&&e.created_at===oldest&&this.validPublic(e))];
    const ids=new Set([...this.publicEvents.keys(),...merged.map(e=>e.id)]);
    demand([...ids].filter(id=>eventRoom(this.publicEvents.get(id)??merged.find(e=>e.id===id)!)===room).length<=LOBBY_LIMIT,'history-limit','本轮历史达到 1000 条上限，已保留当前记录。');
    for(const event of merged)this.insertPublic(event);
    await this.cachePublic();
    state.until=oldest-1;state.loaded=true;
  }
  private async receive(candidate:Event,live=false){
    const parsed=eventSchema.safeParse(candidate);if(!parsed.success)return;
    const event=parsed.data;
    if(!verifyEvent(event))return;
    if(event.kind===LOBBY_KIND){
      if(!this.validPublic(event)||this.publicEvents.has(event.id))return;
      if([...this.publicEvents.values()].filter(e=>e.pubkey===event.pubkey&&e.created_at>now()-60).length>=30&&event.created_at>now()-60)return;
      this.insertPublic(event);
      await this.cachePublic();
      if(live&&event.pubkey!==this.stored.publicKey&&!this.data?.blocked.includes(event.pubkey)&&!this.guestBlocked.has(event.pubkey))this.addNotice({id:event.id,room:eventRoom(event),createdAt:now()});
      return;
    }
    if(event.kind===PRESENCE_SNAPSHOT_KIND){
      let value;try{value=presenceSnapshot.parse(JSON.parse(event.content));}catch{return;}
      this.roomOnline={general:value.rooms.general??0,builders:value.rooms.builders??0,random:value.rooms.random??0};return;
    }
    if(event.kind===PRESENCE_KIND){
      const room=eventRoom(event);if(!room||event.created_at>now()+60)return;
      let value;try{value=presencePayload.parse(JSON.parse(event.content));}catch{return;}
      if(live&&value.action==='join'&&event.pubkey!==this.stored.publicKey){
        const entry={id:event.id,room,publicKey:event.pubkey,name:value.name,createdAt:event.created_at};
        if(!this.roomEntries.some(row=>row.id===event.id))this.roomEntries=[...this.roomEntries,entry].slice(-20);
        if(this.stored.entryNotificationsEnabled)this.addNotice({id:event.id,room,createdAt:now(),kind:'entry',name:value.name});
      }
      return;
    }
    if(!this.secret||!this.data||event.pubkey===this.stored.publicKey)return;
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
    let receivedText=false;
    await this.change(data=>{
      if(!data.peers[peer]){const known=this.knownPublicPeer(peer);if(known&&Object.keys(data.peers).length<500)data.peers[peer]=known;}
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
        data.messages.push({id:value.id,peer,text:value.text,mine:false,createdAt:rumor.created_at,status:'received'});receivedText=true;
      }
      data.seen.push(`${peer}:${value.id}`);data.seen=data.seen.slice(-2000);
    });
    if(live&&receivedText)this.addNotice({id:`${peer}:${value.id}`,peer,createdAt:now()});
  }
  private stop(){
    if(this.timer)clearInterval(this.timer);this.timer=undefined;
    this.transport.close();this.secret?.fill(0);this.secret=undefined;this.data=undefined;this.publishedAt=0;
  }
  async close(){this.closing=true;this.wakeNotices();if(this.timer)clearInterval(this.timer);try{await this.publishPresence('leave',this.stored.selectedRoom);}catch{}this.transport.close();await this.chain;this.stop();this.closed=true;}
}
