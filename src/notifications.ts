import { ROOMS, type RoomId } from './model.js';
export interface MessageNotice {id:string;room?:RoomId;peer?:string;createdAt:number;}
export interface NoticeBatch {revision:number;enabled:boolean;items:MessageNotice[];}
export const readingConversation:{view?:string;room?:RoomId;peer?:string}={};

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
      const batch=await this.poll();if(this.stopped)return;
      const fresh=batch.items.filter(item=>!this.seen.has(item.id));this.seen=new Set(batch.items.map(item=>item.id));
      if(!this.initialized){this.initialized=true;return;}
      if(!batch.enabled||typeof Notification==='undefined'||Notification.permission!=='granted')return;
      // A burst becomes at most one notification per conversation, never a popup storm.
      const groups=new Map<string,MessageNotice>();
      for(const item of fresh)if(Date.now()/1000-item.createdAt<60&&!this.isReading(item))groups.set(item.room??item.peer??item.id,item);
      for(const [key,item] of groups){
        if(Date.now()-(this.lastShown.get(key)??0)<10000)continue;
        this.lastShown.set(key,Date.now());
        try{
          const room=ROOMS.find(r=>r.id===item.room);
          const notification=new Notification(room?`DSH 搭子 · ${room.name}`:'DSH 搭子 · 私信',{body:room?'房间里有新消息，点击返回查看。':'收到新的私信，点击返回查看。',tag:`dsh-friends:${key}`});
          this.open.add(notification);
          notification.onclose=()=>this.open.delete(notification);
          notification.onerror=()=>{this.open.delete(notification);this.failed('系统未能显示新消息提醒，请检查系统通知设置。');};
          notification.onclick=()=>{notification.close();this.open.delete(notification);if(!this.stopped)this.openConversation(item);};
        }catch{this.failed('此宿主暂时无法显示系统通知，聊天收发不受影响。');}
      }
    }catch{this.failedPoll=true;/* Retry transport failures without a tight request loop. */}
    finally{this.running=false;}
  }
  stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);for(const notification of this.open)notification.close();this.open.clear();}
}
