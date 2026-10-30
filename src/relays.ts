import { Relay, type Subscription } from 'nostr-tools/relay';
import type { Event, EventTemplate, VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { PROFILE_KIND, PROFILE_TAG, LOBBY_KIND, LOBBY_TAG } from './model.js';

/** All sockets and scoped NIP-42 challenges stay on the Host. */
export class RelayTransport {
  readonly status=new Map<string,'idle'|'connecting'|'connected'|'failed'>();
  readonly privateStatus=new Map<string,'idle'|'ready'|'authenticating'|'failed'>();
  readonly details=new Map<string,string>();
  private links=new Map<string,Relay>();
  private subscriptions=new Map<string,Subscription>();
  private subscribedKeys=new Map<string,string>();
  private authenticating=new Map<string,Promise<void>>();
  private generation=0;
  private activeKey?:string;
  constructor(readonly urls:readonly string[],private receive:(event:Event)=>void,private signAuth?:(event:EventTemplate)=>Promise<VerifiedEvent>){
    for(const url of urls){this.status.set(url,'idle');this.privateStatus.set(url,'idle');}
  }
  private closeSubscription(key:string){const old=this.subscriptions.get(key);this.subscriptions.delete(key);old?.close();}
  private current(url:string,relay:Relay,generation:number){return this.generation===generation&&this.links.get(url)===relay;}
  private authRequired(reason:string){return reason.includes('auth-required:');}
  async connect(publicKey?:string){
    this.activeKey=publicKey;const generation=this.generation;
    await Promise.allSettled(this.urls.map(async url=>{
      let relay=this.links.get(url);
      if(!relay?.connected){
        this.closeSubscription(url+':public');this.closeSubscription(url+':private');relay?.close();
        relay=new Relay(url,{enableReconnect:false});relay.publishTimeout=4000;relay.baseEoseTimeout=3000;
        const link=relay;this.links.set(url,link);this.status.set(url,'connecting');
        link.onclose=()=>{if(this.current(url,link,generation)){this.status.set(url,'failed');this.privateStatus.set(url,'failed');}};
        try{await link.connect({timeout:4000});if(!this.current(url,link,generation)){link.close();return;}}
        catch{link.close();if(this.current(url,link,generation))this.status.set(url,'failed');return;}
      }
      this.status.set(url,'connected');
      const changed=this.subscribedKeys.get(url)!==(publicKey??'');
      const publicSub=this.subscriptions.get(url+':public');
      if(changed||!publicSub||publicSub.closed)this.subscribePublic(url,relay,publicKey);
      if(!publicKey){this.closeSubscription(url+':private');this.privateStatus.set(url,'idle');}
      else{const privateSub=this.subscriptions.get(url+':private');if(changed||!privateSub||privateSub.closed)this.subscribePrivate(url,relay,publicKey);}
      this.subscribedKeys.set(url,publicKey??'');
    }));
  }
  private subscribePublic(url:string,relay:Relay,publicKey?:string){
    const key=url+':public',generation=this.generation;this.closeSubscription(key);
    const filters:Filter[]=[{kinds:[LOBBY_KIND],'#t':[LOBBY_TAG],since:Math.floor(Date.now()/1000)-30*86400,limit:200}];
    if(publicKey)filters.push({kinds:[PROFILE_KIND],'#d':[PROFILE_TAG],limit:200});
    const sub=relay.subscribe(filters,{onevent:event=>this.receive(event),onclose:reason=>{
      if(this.current(url,relay,generation)&&this.subscriptions.get(key)===sub){this.details.set(url,reason.slice(0,160));this.status.set(url,'failed');}
    }});this.subscriptions.set(key,sub);
  }
  private subscribePrivate(url:string,relay:Relay,publicKey:string){
    const key=url+':private',generation=this.generation;this.closeSubscription(key);
    const sub=relay.subscribe([{kinds:[1059],'#p':[publicKey],since:Math.floor(Date.now()/1000)-14*86400,limit:200}],{
      onevent:event=>this.receive(event),oneose:()=>{if(this.current(url,relay,generation)&&this.activeKey===publicKey){this.privateStatus.set(url,'ready');this.details.delete(url);}},
      onclose:reason=>{if(!this.current(url,relay,generation)||this.subscriptions.get(key)!==sub||this.activeKey!==publicKey)return;
        this.privateStatus.set(url,'failed');this.details.set(url,reason.slice(0,160));
        if(this.authRequired(reason)&&this.signAuth)void this.authenticate(url,relay,publicKey).then(()=>{if(this.current(url,relay,generation)&&this.activeKey===publicKey)this.subscribePrivate(url,relay,publicKey);}).catch(()=>{});
      },
    });this.subscriptions.set(key,sub);
  }
  private authenticate(url:string,relay:Relay,publicKey:string):Promise<void>{
    const existing=this.authenticating.get(url);if(existing)return existing;
    const generation=this.generation;this.privateStatus.set(url,'authenticating');
    const attempt=(async()=>{if(!this.signAuth||this.activeKey!==publicKey)throw Error('identity locked');
      await relay.auth(async event=>{if(!this.current(url,relay,generation)||this.activeKey!==publicKey)throw Error('identity changed');return this.signAuth!(event);});
    })();this.authenticating.set(url,attempt);
    void attempt.catch(()=>{if(this.current(url,relay,generation)){this.privateStatus.set(url,'failed');this.details.set(url,'私聊身份验证未完成，请重新连接。');}}).finally(()=>{if(this.authenticating.get(url)===attempt)this.authenticating.delete(url);});
    return attempt;
  }
  async query(filters:Filter[]):Promise<Event[]>{
    const results:Event[]=[];
    await Promise.all([...this.links.values()].filter(r=>r.connected).map(relay=>new Promise<void>(resolve=>{
      let sub:Subscription|undefined,done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);sub?.close();resolve();};
      const timer=setTimeout(finish,3000);sub=relay.subscribe(filters,{onevent:event=>{if(results.length<100)results.push(event);},oneose:finish,onclose:finish});
    })));return results;
  }
  async publish(event:Event,urls:readonly string[]=this.urls):Promise<string[]>{
    const results=await Promise.allSettled(urls.map(async url=>{
      const relay=this.links.get(url);if(!relay?.connected)throw Error('not-connected');
      try{await relay.publish(event);}catch(error){if(!this.activeKey||!(error instanceof Error)||!this.authRequired(error.message))throw error;await this.authenticate(url,relay,this.activeKey);await relay.publish(event);}return url;
    }));return results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
  }
  close(){this.generation++;for(const key of this.subscriptions.keys())this.closeSubscription(key);this.subscribedKeys.clear();this.authenticating.clear();for(const relay of this.links.values())relay.close();this.links.clear();this.activeKey=undefined;this.details.clear();for(const url of this.urls){this.status.set(url,'idle');this.privateStatus.set(url,'idle');}}
}
