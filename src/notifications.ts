import { ROOMS, type RoomId } from './model.js';
export interface MessageNotice {id:string;room?:RoomId;peer?:string;createdAt:number;kind?:'message'|'entry';name?:string;}
export interface NoticeBatch {revision:number;enabled:boolean;entryEnabled:boolean;items:MessageNotice[];unreadItems:MessageNotice[];}
export const readingConversation:{view?:string;room?:RoomId;peer?:string}={};

export interface UnreadSnapshot {total:number;publicTotal:number;privateTotal:number;rooms:Record<RoomId,number>;peers:Record<string,number>;}
const emptyUnread=():UnreadSnapshot=>({total:0,publicTotal:0,privateTotal:0,rooms:{general:0,builders:0,random:0},peers:{}});
export class UnreadNotifications {
  private snapshot=emptyUnread();private listeners=new Set<()=>void>();private signature='';
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  getSnapshot=()=>this.snapshot;
  sync(items:MessageNotice[]=[]){
    const messages=[...new Map(items.filter(item=>item.kind!=='entry').map(item=>[item.id,item])).values()];
    const rooms:Record<RoomId,number>={general:0,builders:0,random:0},peers:Record<string,number>={};
    for(const item of messages){if(item.room)rooms[item.room]++;else if(item.peer)peers[item.peer]=(peers[item.peer]??0)+1;}
    const publicTotal=Object.values(rooms).reduce((sum,count)=>sum+count,0),privateTotal=Object.values(peers).reduce((sum,count)=>sum+count,0);
    const signature=JSON.stringify([rooms,Object.entries(peers).sort()]);if(signature===this.signature)return;
    this.signature=signature;this.snapshot={total:publicTotal+privateTotal,publicTotal,privateTotal,rooms,peers};for(const listener of this.listeners)listener();
  }
  clear(target:{room?:RoomId;peer?:string}){
    const next={...this.snapshot,rooms:{...this.snapshot.rooms},peers:{...this.snapshot.peers}};
    if(target.room)next.rooms[target.room]=0;if(target.peer)delete next.peers[target.peer];
    next.publicTotal=Object.values(next.rooms).reduce((sum,count)=>sum+count,0);next.privateTotal=Object.values(next.peers).reduce((sum,count)=>sum+count,0);next.total=next.publicTotal+next.privateTotal;
    const signature=JSON.stringify([next.rooms,Object.entries(next.peers).sort()]);if(signature===this.signature)return;
    this.signature=signature;this.snapshot=next;for(const listener of this.listeners)listener();
  }
}
export const unreadNotifications=new UnreadNotifications();
export const unreadLabel=(count:number)=>count>99?'99+':String(count);

/** Uses the standard renderer Notification API, independent of the mounted panel.
 * No background daemon and no dependency on an Electron/private host bridge.
 */
export class MessageNotifications {
  private timer?:ReturnType<typeof setInterval>;
  private seen=new Set<string>();private initialized=false;private stopped=false;private running=false;private failedPoll=false;
  private lastShown=new Map<string,number>();private open=new Set<Notification>();
  constructor(private poll:()=>Promise<NoticeBatch>,private isReading:(item:MessageNotice)=>boolean,private openConversation:(item:MessageNotice)=>void,private failed:(message:string)=>void){}
  start(){void this.loop();}
  private async loop(){
    while(!this.stopped){
      await this.tick();
      if(this.failedPoll&&!this.stopped)await new Promise<void>(resolve=>{this.timer=setTimeout(resolve,2000);});
    }
  }
  async tick(){
    if(this.running||this.stopped)return;this.running=true;this.failedPoll=false;
    try{
      const batch=await this.poll();if(this.stopped)return;unreadNotifications.sync(batch.unreadItems??[]);
      const fresh=batch.items.filter(item=>!this.seen.has(item.id));this.seen=new Set(batch.items.map(item=>item.id));
      if(!this.initialized){this.initialized=true;return;}
      if((!batch.enabled&&!batch.entryEnabled)||typeof Notification==='undefined'||Notification.permission!=='granted')return;
      // A burst becomes at most one notification per conversation, never a popup storm.
      const groups=new Map<string,MessageNotice>();
      for(const item of fresh)if((item.kind==='entry'?batch.entryEnabled:batch.enabled)&&Date.now()/1000-item.createdAt<60&&!this.isReading(item))groups.set(`${item.kind??'message'}:${item.room??item.peer??item.id}`,item);
      for(const [key,item] of groups){
        if(Date.now()-(this.lastShown.get(key)??0)<10000)continue;
        this.lastShown.set(key,Date.now());
        try{
          const room=ROOMS.find(r=>r.id===item.room);
          const entry=item.kind==='entry';
          const notification=new Notification(room?`DSH 搭子 · ${room.name}`:'DSH 搭子 · 私信',{body:entry?`${item.name??'新搭子'} 来到了 ${room?.name??'房间'}。`:room?'房间里有新消息，点击返回查看。':'收到新的私信，点击返回查看。',tag:`dsh-friends:${entry?'entry:':''}${key}`});
          this.open.add(notification);
          notification.onclose=()=>this.open.delete(notification);
          notification.onerror=()=>{this.open.delete(notification);this.failed('系统未能显示新消息提醒，请检查系统通知设置。');};
          notification.onclick=()=>{notification.close();this.open.delete(notification);if(!this.stopped)this.openConversation(item);};
        }catch{this.failed('此宿主暂时无法显示系统通知，聊天收发不受影响。');}
      }
    }catch{this.failedPoll=true;/* Retry transport failures without a tight request loop. */}
    finally{this.running=false;}
  }
  stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);for(const notification of this.open)notification.close();this.open.clear();unreadNotifications.sync([]);}
}
