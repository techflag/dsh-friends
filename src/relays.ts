import { AbstractRelay as Relay, type Subscription } from 'nostr-tools/abstract-relay';
import {verifyEvent} from 'nostr-tools/pure';
import type { Event, EventTemplate, VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { PROFILE_KIND, PROFILE_TAG, LOBBY_KIND, PRESENCE_KIND, PRESENCE_SNAPSHOT_KIND, ROOMS } from './model.js';
import WebSocket from 'ws';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';
import type {Agent} from 'node:http';
import {hostProxyPolicy,connectionFailure,type ProxyPolicy} from './network.js';

/** All sockets and scoped NIP-42 challenges stay on the Host. */
export class RelayTransport {
  readonly status=new Map<string,'idle'|'connecting'|'connected'|'failed'>();
  readonly privateStatus=new Map<string,'idle'|'ready'|'authenticating'|'failed'>();
  readonly details=new Map<string,string>();
  readonly routes=new Map<string,string>();
  private agents=new Map<string,Agent>();
  private links=new Map<string,Relay>();
  private subscriptions=new Map<string,Subscription>();
  private subscribedKeys=new Map<string,string>();
  private authenticating=new Map<string,Promise<void>>();
  private generation=0;
  private activeKey?:string;
  constructor(readonly urls:readonly string[],private receive:(event:Event,live?:boolean)=>void,private signAuth?:(event:EventTemplate)=>Promise<VerifiedEvent>,private proxyPolicy:()=>Promise<ProxyPolicy>=hostProxyPolicy){
    for(const url of urls){this.status.set(url,'idle');this.privateStatus.set(url,'idle');}
  }
  private closeSubscription(key:string){const old=this.subscriptions.get(key);this.subscriptions.delete(key);old?.close();}
  private current(url:string,relay:Relay,generation:number){return this.generation===generation&&this.links.get(url)===relay;}
  private authRequired(reason:string){return reason.includes('auth-required:');}
  async connect(publicKey?:string){
    this.activeKey=publicKey;const generation=this.generation;
    let policy:ProxyPolicy|undefined;
    if(this.urls.some(url=>!this.links.get(url)?.connected)){
      try{policy=await this.proxyPolicy();}catch(error){for(const url of this.urls)if(!this.links.get(url)?.connected){this.status.set(url,'failed');this.details.set(url,error instanceof Error?error.message:'无法读取连接设置。');}return;}
      if(generation!==this.generation)return;
    }
    await Promise.allSettled(this.urls.map(async url=>{
      let relay=this.links.get(url);
      if(!relay?.connected){
        this.closeSubscription(url+':public');this.closeSubscription(url+':private');relay?.close();
        this.agents.get(url)?.destroy();this.agents.delete(url);
        let proxy:string;
        try{proxy=policy!.proxyForUrl(url);}catch(error){this.status.set(url,'failed');this.details.set(url,error instanceof Error?error.message:'代理设置无法识别。');return;}
        this.routes.set(url,proxy?policy!.label:'直接连接');this.details.delete(url);
        const agent=proxy?(proxy.startsWith('socks')?new SocksProxyAgent(proxy):new HttpsProxyAgent(proxy)):undefined;
        if(agent)this.agents.set(url,agent);
        const transport=this;
        class HostSocket extends WebSocket {
          constructor(address:string){super(address,{agent,handshakeTimeout:12000,maxPayload:1024*1024});this.on('error',error=>{if(generation===transport.generation&&transport.links.get(url)===relay)transport.details.set(url,connectionFailure(error,Boolean(proxy)));});}
        }
        relay=new Relay(url,{verifyEvent:event=>verifyEvent(event),enableReconnect:false,websocketImplementation:HostSocket as unknown as typeof globalThis.WebSocket});relay.publishTimeout=6000;relay.baseEoseTimeout=3000;
        const link=relay;this.links.set(url,link);this.status.set(url,'connecting');
        link.onclose=()=>{if(this.current(url,link,generation)){this.status.set(url,'failed');this.privateStatus.set(url,'failed');}};
        try{await link.connect({timeout:12000});if(!this.current(url,link,generation)){link.close();return;}}
        catch(error){if(this.current(url,link,generation)){this.status.set(url,'failed');if(!this.details.has(url))this.details.set(url,connectionFailure(error,Boolean(proxy)));}link.close();return;}
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
    const filters:Filter[]=ROOMS.map(room=>({kinds:[LOBBY_KIND],'#t':[room.tag],limit:50}));
    filters.push(...ROOMS.map(room=>({kinds:[PRESENCE_KIND,PRESENCE_SNAPSHOT_KIND],'#t':[room.tag],since:Math.floor(Date.now()/1000)-120,limit:50})));
    if(publicKey)filters.push({kinds:[PROFILE_KIND],'#d':[PROFILE_TAG],limit:200});
    let caughtUp=false;
    const sub=relay.subscribe(filters,{onevent:event=>this.receive(event,caughtUp),oneose:()=>{caughtUp=true;},onclose:reason=>{
      if(this.current(url,relay,generation)&&this.subscriptions.get(key)===sub){this.details.set(url,reason.slice(0,160));this.status.set(url,'failed');}
    }});this.subscriptions.set(key,sub);
  }
  private subscribePrivate(url:string,relay:Relay,publicKey:string){
    const key=url+':private',generation=this.generation;this.closeSubscription(key);
    let caughtUp=false;
    const sub=relay.subscribe([{kinds:[1059],'#p':[publicKey],since:Math.floor(Date.now()/1000)-14*86400,limit:200}],{
      onevent:event=>this.receive(event,caughtUp),oneose:()=>{caughtUp=true;if(this.current(url,relay,generation)&&this.activeKey===publicKey){this.privateStatus.set(url,'ready');this.details.delete(url);}},
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
  async queryPage(filters:Filter[]):Promise<{events:Event[];complete:boolean;saturated:boolean}> {
    const links=[...this.links.values()].filter(r=>r.connected);
    const pages=await Promise.all(links.map(relay=>new Promise<{events:Event[];complete:boolean}>(resolve=>{
      const events:Event[]=[];let sub:Subscription|undefined,done=false;
      const finish=(complete=false)=>{if(done)return;done=true;clearTimeout(timer);sub?.close();resolve({events,complete});};
      const timer=setTimeout(()=>finish(),3500);
      sub=relay.subscribe(filters,{onevent:event=>{if(events.length<1100)events.push(event);},oneose:()=>finish(true),onclose:()=>finish()});
      if(done)sub.close();
    })));
    return {events:pages.flatMap(p=>p.events),complete:links.length>0&&pages.every(p=>p.complete),saturated:pages.some(p=>p.events.length>=filters.reduce((n,f)=>n+(f.limit??200),0))};
  }
  async query(filters:Filter[]):Promise<Event[]>{return (await this.queryPage(filters)).events;}
  async publish(event:Event,urls:readonly string[]=this.urls):Promise<string[]>{
    const results=await Promise.allSettled(urls.map(async url=>{
      const relay=this.links.get(url);if(!relay?.connected)throw Error('not-connected');
      try{await relay.publish(event);}catch(error){if(!this.activeKey||!(error instanceof Error)||!this.authRequired(error.message))throw error;await this.authenticate(url,relay,this.activeKey);await relay.publish(event);}return url;
    }));return results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
  }
  close(){this.generation++;for(const key of this.subscriptions.keys())this.closeSubscription(key);this.subscribedKeys.clear();this.authenticating.clear();for(const relay of this.links.values())relay.close();this.links.clear();for(const agent of this.agents.values())agent.destroy();this.agents.clear();this.routes.clear();this.activeKey=undefined;this.details.clear();for(const url of this.urls){this.status.set(url,'idle');this.privateStatus.set(url,'idle');}}
}
