import { WebSocketServer, type WebSocket } from 'ws';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import { verifyEvent, type Event } from 'nostr-tools/pure';

/** Actual loopback WebSocket relay. Never forwards to the public network. */
export async function localRelay(){
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const records=new Map<string,Event>(),subscriptions=new Map<WebSocket,Map<string,Filter[]>>();
  const fixture={url:`ws://127.0.0.1:${(server.address() as {port:number}).port}`,rejectPublishes:false,events:records,attempts:[] as string[],async close(){for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
  const send=(client:WebSocket,data:unknown)=>{if(client.readyState===1)client.send(JSON.stringify(data));};
  server.on('connection',client=>{
    subscriptions.set(client,new Map());client.on('close',()=>subscriptions.delete(client));
    client.on('message',bytes=>{
      let frame;try{frame=JSON.parse(bytes.toString());}catch{return;}
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
        const id=frame[1],filters=frame.slice(2) as Filter[];subscriptions.get(client)!.set(id,filters);
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
