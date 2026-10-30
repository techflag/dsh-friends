import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import { verifyEvent, type Event } from 'nostr-tools/pure';

/** Actual loopback WebSocket relay. Never forwards to the public network. */
export async function localRelay(options:{requirePrivateAuth?:boolean}={}){
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const records=new Map<string,Event>(),subscriptions=new Map<WebSocket,Map<string,Filter[]>>();
  const fixture={url:`ws://127.0.0.1:${(server.address() as {port:number}).port}`,rejectPublishes:false,rejectAuth:false,authEvents:[] as Event[],events:records,attempts:[] as string[],async close(){for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
  const send=(client:WebSocket,data:unknown)=>{if(client.readyState===1)client.send(JSON.stringify(data));};
  server.on('connection',client=>{
    const challenge=randomUUID(),authenticated=new Set<string>();
    if(options.requirePrivateAuth)send(client,['AUTH',challenge]);
    subscriptions.set(client,new Map());client.on('close',()=>subscriptions.delete(client));
    client.on('message',bytes=>{
      let frame;try{frame=JSON.parse(bytes.toString());}catch{return;}
      if(frame[0]==='AUTH'){
        const event=frame[1] as Event;const valid=!fixture.rejectAuth&&event.kind===22242&&verifyEvent(event)&&event.tags.some(t=>t[0]==='challenge'&&t[1]===challenge)&&event.tags.some(t=>t[0]==='relay'&&new URL(t[1]).href===new URL(fixture.url).href);
        if(valid){authenticated.add(event.pubkey);fixture.authEvents.push(event);}send(client,['OK',event.id,valid,valid?'':'restricted: fixture auth refused']);return;
      }
      if(frame[0]==='EVENT'){
        const event=frame[1] as Event;fixture.attempts.push(event.id);
        if(fixture.rejectPublishes||!verifyEvent(event)){send(client,['OK',event.id,false,'rejected']);return;}
        if((event.kind>=30000&&event.kind<40000)||event.kind===10050){
          const d=event.tags.find(t=>t[0]==='d')?.[1]??'';
          for(const [id,old] of records){
            if(old.kind!==event.kind||old.pubkey!==event.pubkey||(old.tags.find(t=>t[0]==='d')?.[1]??'')!==d)continue;
            if(old.created_at>event.created_at||(old.created_at===event.created_at&&old.id<event.id)){send(client,['OK',event.id,true,'older-replaceable']);return;}
            records.delete(id);
          }
        }
        records.set(event.id,event);send(client,['OK',event.id,true,'']);
        for(const [target,subs] of subscriptions)for(const [id,filters] of subs)if(filters.some(f=>matchFilter(f,event)))send(target,['EVENT',id,event]);
      }else if(frame[0]==='REQ'){
        const id=frame[1],filters=frame.slice(2) as Filter[];
        if(options.requirePrivateAuth&&filters.some(filter=>filter.kinds?.includes(1059)&&filter['#p']?.some(key=>!authenticated.has(key)))){send(client,['CLOSED',id,'auth-required: authenticate before reading private messages']);return;}
        subscriptions.get(client)!.set(id,filters);
        const delivered=new Set<string>();
        for(const filter of filters)for(const event of [...records.values()].filter(e=>matchFilter(filter,e)).sort((a,b)=>b.created_at-a.created_at).slice(0,filter.limit??200)){
          if(!delivered.has(event.id)){send(client,['EVENT',id,event]);delivered.add(event.id);}
        }
        send(client,['EOSE',id]);
      }else if(frame[0]==='CLOSE')subscriptions.get(client)?.delete(frame[1]);
    });
  });
  return fixture;
}
