import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect,type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {finalizeEvent,generateSecretKey} from 'nostr-tools/pure';
import {systemProxyForUrl,hostProxyPolicy,connectionFailure,type SystemProxy} from '../src/network.js';
import {RelayTransport} from '../src/relays.js';
import {localRelay} from './relay-fixture.js';

const settings:SystemProxy={enabled:true,server:'127.0.0.1:7890',bypass:'<local>;*.internal;example.test:99',pac:''};
test('Windows proxy parsing supports common system forms, bypass rules and rejects unsupported PAC',()=>{
  assert.equal(systemProxyForUrl(settings,'wss://relay.example/'),'http://127.0.0.1:7890/');
  assert.equal(systemProxyForUrl(settings,'ws://127.0.0.1:3000/'),'');
  assert.equal(systemProxyForUrl(settings,'wss://intranet.internal/'),'');
  assert.equal(systemProxyForUrl(settings,'wss://example.test:99/'),'');
  const split={...settings,server:'http=127.0.0.1:8001;https=127.0.0.1:8002'};
  assert.equal(systemProxyForUrl(split,'wss://relay.example'),'http://127.0.0.1:8002/');
  assert.equal(systemProxyForUrl(split,'ws://relay.example'),'http://127.0.0.1:8001/');
  assert.equal(systemProxyForUrl({...settings,server:'socks=127.0.0.1:8003'},'wss://relay.example'),'socks5h://127.0.0.1:8003');
  assert.throws(()=>systemProxyForUrl({...settings,enabled:false,pac:'https://example.test/proxy.pac'},'wss://relay.example'),/PAC/);
  assert.throws(()=>systemProxyForUrl({...settings,server:'file:///etc/passwd'},'wss://relay.example'),/暂不支持/);
});

test('environment HTTPS proxy applies to secure WebSockets and NO_PROXY is respected',async()=>{
  const saved={...process.env};
  try{
    for(const key of Object.keys(process.env))if(/proxy/i.test(key))delete process.env[key];
    process.env.HTTPS_PROXY='http://127.0.0.1:7999';process.env.NO_PROXY='localhost,127.0.0.1';
    const policy=await hostProxyPolicy('win32',async()=>{throw Error('must use explicit environment');});
    assert.equal(policy.proxyForUrl('wss://relay.example'),'http://127.0.0.1:7999');
    assert.equal(policy.proxyForUrl('wss://localhost'),'');
    delete process.env.HTTPS_PROXY;delete process.env.NO_PROXY;
    const system=await hostProxyPolicy('win32',async()=>settings);
    assert.equal(system.label,'Windows 系统代理');
    assert.equal(system.proxyForUrl('wss://relay.example'),'http://127.0.0.1:7890/');
  }finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});

test('real relay traffic traverses an HTTP CONNECT proxy without direct DNS or public writes',async()=>{
  const relay=await localRelay(),proxy=createServer(),sockets=new Set<Socket>();let tunnels=0;
  proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  proxy.on('connect',(request,client,head)=>{
    assert.equal(request.url,'relay.dsh-friends.invalid:80');tunnels++;
    const upstream=connect(Number(new URL(relay.url).port),'127.0.0.1',()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);
    });
    sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
  });
  await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const proxyUrl=`http://127.0.0.1:${(proxy.address() as {port:number}).port}`;
  const url='ws://relay.dsh-friends.invalid',received:string[]=[];
  const transport=new RelayTransport([url],event=>received.push(event.id),undefined,async()=>({label:'Windows 系统代理',proxyForUrl:()=>proxyUrl}));
  try{
    await transport.connect();assert.equal(transport.status.get(url),'connected');assert.equal(tunnels,1);assert.equal(transport.routes.get(url),'Windows 系统代理');
    const event=finalizeEvent({kind:9,created_at:Math.floor(Date.now()/1000),tags:[['t','dsh-friends-lobby-v1']],content:'合成本地代理验收 '+randomUUID()},generateSecretKey());
    assert.deepEqual(await transport.publish(event),[url]);
    const end=Date.now()+2000;while(!received.includes(event.id)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(received.includes(event.id),'relay event arrives through the tunnel');
  }finally{transport.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await relay.close();}
});

test('connection errors provide actionable reasons without echoing proxy credentials',()=>{
  const secret='http://user:private-password@127.0.0.1:1';
  const refused=Object.assign(new Error(secret),{code:'ECONNREFUSED'});
  assert.match(connectionFailure(refused,true),/代理端口拒绝/);
  assert.equal(connectionFailure(refused,true).includes('private-password'),false);
  assert.match(connectionFailure('connection timed out',true),/代理连接超时/);
  assert.match(connectionFailure({code:'CERT_HAS_EXPIRED'},false),/证书/);
});
