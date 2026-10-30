import { Relay, type Subscription } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { PROFILE_KIND, PROFILE_TAG } from './model.js';

/** All sockets live on the Host. Only pre-approved nodes are dialled. */
export class RelayTransport {
  readonly status = new Map<string,'idle'|'connecting'|'connected'|'failed'>();
  private links = new Map<string,Relay>();
  private subscriptions = new Map<string,Subscription>();
  private generation=0;
  constructor(readonly urls:readonly string[], private receive:(event:Event)=>void) {
    for(const url of urls) this.status.set(url,'idle');
  }
  async connect(publicKey:string) {
    const generation=this.generation;
    await Promise.allSettled(this.urls.map(async url=>{
      if(this.links.get(url)?.connected)return;
      this.subscriptions.get(url)?.close();this.subscriptions.delete(url);
      this.links.get(url)?.close();
      const relay=new Relay(url,{enableReconnect:false});
      relay.publishTimeout=4000; relay.baseEoseTimeout=3000;
      this.links.set(url,relay); this.status.set(url,'connecting');
      relay.onclose=()=>{if(this.generation===generation)this.status.set(url,'failed');};
      try {
        await relay.connect({timeout:4000});
        if(generation!==this.generation){relay.close();return;}
        this.status.set(url,'connected');
        const sub=relay.subscribe([
          {kinds:[PROFILE_KIND],'#d':[PROFILE_TAG],limit:200},
          {kinds:[1059],'#p':[publicKey],limit:200},
        ],{onevent:event=>this.receive(event),onclose:()=>{if(generation===this.generation)this.status.set(url,'failed');}});
        this.subscriptions.set(url,sub);
      } catch {relay.close();if(generation===this.generation)this.status.set(url,'failed');}
    }));
  }
  async query(filters:Filter[]):Promise<Event[]> {
    const results:Event[]=[];
    await Promise.all([...this.links.values()].filter(r=>r.connected).map(relay=>new Promise<void>(resolve=>{
      let sub:Subscription|undefined,done=false;
      const finish=()=>{if(done)return;done=true;clearTimeout(timer);sub?.close();resolve();};
      const timer=setTimeout(finish,3000);
      sub=relay.subscribe(filters,{onevent:event=>{if(results.length<100)results.push(event);},oneose:finish,onclose:finish});
    })));
    return results;
  }
  async publish(event:Event, urls:readonly string[]=this.urls):Promise<string[]> {
    const results=await Promise.allSettled(urls.map(async url=>{
      const relay=this.links.get(url);
      if(!relay?.connected)throw new Error('not-connected');
      await relay.publish(event);return url;
    }));
    return results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
  }
  close(){
    this.generation++;
    for(const sub of this.subscriptions.values())sub.close();this.subscriptions.clear();
    for(const relay of this.links.values())relay.close();this.links.clear();
    for(const url of this.urls)this.status.set(url,'idle');
  }
}
