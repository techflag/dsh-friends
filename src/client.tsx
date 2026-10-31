import { MessageNotifications, readingConversation, type NoticeBatch } from './notifications.js';
import { Avatar } from './avatar.js';
import { PLUGIN_VERSION, PLUGIN_REVISION } from './version.js';
import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {MainPanelId} from '@deepseek-ai/dsh-client-ui-layout/client';
import { Button } from './ui.js';
import { ROOMS, type RoomId, type Snapshot, type Peer, type Profile, type LobbyPost } from './model.js';
import { Lobby } from './lobby.js';
import { styles } from './client-style.js';

type Call=(endpoint:string,payload?:unknown)=>Promise<unknown>;
const short=(key:string)=>`${key.slice(0,8)}…${key.slice(-6)}`;
const states={idle:'未连接',connecting:'连接中',connected:'已连接',failed:'连接失败'};
const messageStates={sending:'正在发送', 'relay-accepted':'已到中继', failed:'发送失败',received:'已收到'};

function IdentityGate({snapshot,call,busy}:{snapshot:Snapshot;call:Call;busy:boolean}){
  const [pass,setPass]=React.useState(''),[again,setAgain]=React.useState(''),[name,setName]=React.useState(''),[vault,setVault]=React.useState(''),[importing,setImporting]=React.useState(false),[error,setError]=React.useState('');
  const locked=snapshot.identity==='locked';
  async function submit(event:React.FormEvent){
    event.preventDefault();setError('');
    if(!locked&&(pass.trim().length<12||pass!==again)){setError('请设置至少 12 个字符的口令，并确保两次输入一致。');return;}
    try{
      await call(locked?'identity.unlock':importing?'identity.import':'identity.create',locked?{password:pass}:importing?{password:pass,vault:vault.trim()}:{password:pass,profile:{name:name.trim(),bio:'',tags:[],looking:''}});
      setPass('');setAgain('');setVault('');
    }catch{ /* Parent renders the sanitized Host error. */ }
  }
  return <section className="df-gate"><h1>{locked?'解锁搭子身份':importing?'导入已有身份':'创建你的搭子身份'}</h1><p>{locked?'口令只用于本地解锁，私钥不会交给界面或中继。':'身份用于署名和加密私聊，在本地生成并用口令保护。中继要求时会验证公开身份。返回大厅后即可发言，不会自动公开完整名片。'}</p><form onSubmit={submit}>
    {!locked&&!importing&&<label className="df-field">昵称<input required maxLength={20} value={name} onChange={e=>setName(e.target.value)} autoComplete="nickname"/></label>}
    {!locked&&importing&&<label className="df-field">加密身份备份<textarea required rows={4} value={vault} onChange={e=>setVault(e.target.value)} placeholder="ncryptsec1…" maxLength={300}/><small>只接收口令加密的备份，不接收明文私钥。</small></label>}
    <label className="df-field">{locked?'解锁口令':'备份口令'}<input type="password" required value={pass} onChange={e=>setPass(e.target.value)} autoComplete={locked?'current-password':'new-password'} maxLength={128}/></label>
    {!locked&&<label className="df-field">再次输入口令<input type="password" required value={again} onChange={e=>setAgain(e.target.value)} autoComplete="new-password" maxLength={128}/></label>}
    {error&&<p role="alert">{error}</p>}<div className="df-actions"><Button variant="primary" disabled={busy} type="submit">{busy?'处理中…':locked?'解锁':importing?'导入身份':'创建身份'}</Button>{!locked&&<Button type="button" onClick={()=>{setImporting(!importing);setError('');}}>{importing?'返回创建':'已有加密备份？'}</Button>}</div>
  </form><p>请保管好备份与口令。项目作者无法代你找回身份。</p></section>;
}

function ProfileForm({profile,call,busy}:{profile:Profile;call:Call;busy:boolean}){
  const [value,setValue]=React.useState(profile),[tags,setTags]=React.useState(profile.tags.join('、'));
  return <form onSubmit={event=>{event.preventDefault();void call('profile.update',{...value,tags:tags.split(/[、,，]/).map(t=>t.trim()).filter(Boolean).slice(0,3)}).catch(()=>{});}}>
    <label className="df-field">昵称<input required maxLength={20} value={value.name} onChange={e=>setValue({...value,name:e.target.value})}/></label>
    <label className="df-field">一句话介绍<textarea rows={3} maxLength={160} value={value.bio} onChange={e=>setValue({...value,bio:e.target.value})}/></label>
    <label className="df-field">兴趣<input maxLength={60} value={tags} onChange={e=>setTags(e.target.value)}/><small>用顿号分隔，最多三个，每个不超过 16 字。</small></label>
    <label className="df-field">想找搭子做什么<input maxLength={60} value={value.looking} onChange={e=>setValue({...value,looking:e.target.value})}/></label>
    <Button variant="outline" type="submit" disabled={busy}>保存名片</Button>
  </form>;
}

function FriendsApp({invoke}:{invoke:Call}){
  const [snapshot,setSnapshot]=React.useState<Snapshot>(),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[view,setView]=React.useState('lobby');
  const [query,setQuery]=React.useState(''),[tag,setTag]=React.useState(''),[page,setPage]=React.useState(1),[selected,setSelected]=React.useState(''),[threadOpen,setThreadOpen]=React.useState(false);
  const [drafts,setDrafts]=React.useState<Record<string,string>>({}),[modal,setModal]=React.useState<{type:'network'|'discovery'|'person'|'request';peer?:Peer}>(),[greeting,setGreeting]=React.useState('');
  const dialog=React.useRef<HTMLDialogElement>(null),history=React.useRef<HTMLDivElement>(null),mounted=React.useRef(true);
  const [identityPrompt,setIdentityPrompt]=React.useState(false),[lobbyDraft,setLobbyDraft]=React.useState(''),[lobbyReply,setLobbyReply]=React.useState<LobbyPost>(),[pendingRequest,setPendingRequest]=React.useState<Peer>();
  const publicOperation=React.useRef<{text:string;replyTo?:string;id:string;room:RoomId}>();
  const roomDrafts=React.useRef<Record<string,{text:string;reply?:LobbyPost}>>({});
  async function selectRoom(room:RoomId){
    if(!snapshot||room===snapshot.selectedRoom||busy)return;
    roomDrafts.current[snapshot.selectedRoom]={text:lobbyDraft,reply:lobbyReply};
    try{await call('room.select',{room});setLobbyDraft(roomDrafts.current[room]?.text??'');setLobbyReply(roomDrafts.current[room]?.reply);publicOperation.current=undefined;}catch{}
  }
  const [limit,setLimit]=React.useState(100);
  const sendOperations=React.useRef(new Map<string,{text:string;id:string}>());
  const refresh=React.useCallback(async()=>{const next=await invoke('snapshot',{});if(mounted.current)setSnapshot(next as Snapshot);},[invoke]);
  React.useEffect(()=>{mounted.current=true;void refresh().catch(()=>setError('搭子本地服务尚未就绪，请重试。'));const timer=setInterval(()=>{void refresh().catch(()=>{});},3000);return()=>{mounted.current=false;clearInterval(timer);};},[refresh]);
  React.useEffect(()=>{if(modal&&!dialog.current?.open)dialog.current?.showModal();if(!modal&&dialog.current?.open)dialog.current.close();},[modal]);
  React.useEffect(()=>{if(snapshot?.identity!=='ready')setDrafts({});},[snapshot?.identity]);
  const call:Call=React.useCallback(async(endpoint,payload={})=>{
    setBusy(true);setError('');
    try{const value=await invoke(endpoint,payload);if(mounted.current){if(value&&typeof value==='object'&&'identity' in value)setSnapshot(value as Snapshot);else await refresh();}return value;}
    catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'操作未完成。');throw cause;}
    finally{if(mounted.current)setBusy(false);}
  },[invoke,refresh]);
  function act(endpoint:string,payload:unknown={}){void call(endpoint,payload).catch(()=>{});}
  React.useEffect(()=>{if(snapshot?.identity==='ready'){setIdentityPrompt(false);if(pendingRequest){setModal({type:'request',peer:pendingRequest});setPendingRequest(undefined);}}},[snapshot?.identity,pendingRequest]);
  function requestPrivate(p:Peer){if(snapshot?.identity!=='ready'){setModal(undefined);void call('identity.local').then(()=>setModal({type:'request',peer:p})).catch(()=>{});}else setModal({type:'request',peer:p});}
  async function sendPublic(){const text=lobbyDraft.trim(),replyTo=lobbyReply?.id;if(!text||busy)return;let op=publicOperation.current;if(!op||op.text!==text||op.replyTo!==replyTo||op.room!==snapshot?.selectedRoom){op={text,replyTo,room:snapshot?.selectedRoom??'general',id:crypto.randomUUID()};publicOperation.current=op;}await call('lobby.send',{...op,confirmed:true});publicOperation.current=undefined;setLobbyDraft(current=>current.trim()===text?'':current);setLobbyReply(current=>current?.id===replyTo?undefined:current);}
  async function prepareAndSend(){try{await call('identity.local');await sendPublic();}catch{}}
  const versionMismatch=Boolean(snapshot&&(snapshot.runtimeVersion!==PLUGIN_VERSION||snapshot.runtimeRevision!==PLUGIN_REVISION));
  React.useEffect(()=>{readingConversation.view=view;readingConversation.room=snapshot?.selectedRoom;readingConversation.peer=selected;return()=>{readingConversation.view=undefined;};},[view,snapshot?.selectedRoom,selected]);
  React.useEffect(()=>{const open=(event:Event)=>{const notice=(event as CustomEvent<{peer?:string}>).detail;if(notice?.peer){setSelected(notice.peer);setView('messages');setThreadOpen(true);}else setView('lobby');setIdentityPrompt(false);void refresh().catch(()=>{});};const failure=(event:Event)=>setError((event as CustomEvent<string>).detail);window.addEventListener('dsh-friends:open-notice',open);window.addEventListener('dsh-friends:notification-error',failure);return()=>{window.removeEventListener('dsh-friends:open-notice',open);window.removeEventListener('dsh-friends:notification-error',failure);};},[refresh]);
  async function toggleNotifications(){
    if(snapshot?.notificationsEnabled){act('notifications.set',{enabled:false});return;}
    if(typeof Notification==='undefined'){setError('当前桌面暂不支持系统通知。');return;}
    const permission=Notification.permission==='default'?await Notification.requestPermission():Notification.permission;
    if(permission!=='granted'){setError('系统通知未获允许，请在系统或浏览器设置中开启。');return;}
    act('notifications.set',{enabled:true});
  }
  async function toggleEntryNotifications(){
    if(snapshot?.entryNotificationsEnabled){act('notifications.entry.set',{enabled:false});return;}
    if(typeof Notification==='undefined'){setError('当前桌面暂不支持系统通知。');return;}
    const permission=Notification.permission==='default'?await Notification.requestPermission():Notification.permission;
    if(permission!=='granted'){setError('系统通知未获允许，请在系统或浏览器设置中开启。');return;}
    act('notifications.entry.set',{enabled:true});
  }
  const peer=snapshot?.friends.find(p=>p.publicKey===selected);
  const messages=snapshot?.messages.filter(m=>m.peer===selected)??[];
  React.useEffect(()=>{history.current?.scrollTo({top:history.current.scrollHeight});},[messages.length,selected]);
  async function send(event?:React.FormEvent){
    event?.preventDefault();const text=drafts[selected]?.trim();if(!text||busy)return;
    let operation=sendOperations.current.get(selected);
    if(!operation||operation.text!==text){operation={text,id:crypto.randomUUID()};sendOperations.current.set(selected,operation);}
    try{await call('message.send',{peer:selected,text,id:operation.id});sendOperations.current.delete(selected);setDrafts(current=>current[selected]?.trim()===text?({...current,[selected]:''}):current);}catch{}
  }
  function openChat(p:Peer){setSelected(p.publicKey);setView('messages');setThreadOpen(true);setLimit(100);}
  function personButton(p:Peer){return <button className="df-person-name" onClick={()=>setModal({type:'person',peer:p})}><Avatar publicKey={p.publicKey}/><span>{p.name}<small>{short(p.publicKey)}</small></span></button>;}
  async function backup(){
    try{const value=await call('identity.backup') as {encryptedBackup:string};const url=URL.createObjectURL(new Blob([value.encryptedBackup],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='dsh-friends-identity.ncryptsec.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch{}
  }
  const filtered=snapshot?.peers.filter(p=>(!tag||p.tags.includes(tag))&&(!query||[p.name,p.bio,p.looking,...p.tags].some(v=>v.toLowerCase().includes(query.toLowerCase()))))??[];
  const count=Math.max(1,Math.ceil(filtered.length/6)),current=Math.min(page,count),shown=filtered.slice((current-1)*6,current*6);
  const tags=[...new Set(snapshot?.peers.flatMap(p=>p.tags)??[])].sort();
  const incoming=snapshot?.invitations.filter(i=>i.direction==='incoming')??[],outgoing=snapshot?.invitations.filter(i=>i.direction==='outgoing')??[];
  return <div className="dsh-friends"><style>{styles}</style>
    <nav className="df-nav" aria-label="搭子插件导航"><strong>搭子</strong>{[['lobby','社区'],['messages','私信'],['friends','联系人'],['settings','我']].map(([key,label])=><button key={key} className="df-tab" aria-current={view===key?'page':undefined} onClick={()=>{setView(key);setIdentityPrompt(false);setError('');}}>{label}{key==='friends'&&incoming.length?` (${incoming.length})`:''}</button>)}<button className="df-notification-toggle" disabled={busy} title="隐藏或最小化时提醒；部分桌面关闭窗口后会停止提醒，彻底退出后停止接收。" aria-label="新消息提醒" aria-pressed={snapshot?.notificationsEnabled??false} onClick={()=>void toggleNotifications()}>{snapshot?.notificationsEnabled?'提醒已开启':'开启提醒'}</button><span className="df-self df-muted"><Avatar publicKey={snapshot?.publicKey} size="small"/><small>{snapshot?.profile.name??'正在连接本地服务'}</small></span></nav>
    {versionMismatch&&<div className="df-error" role="alert">界面已更新，后台仍在运行旧版插件。请重新启动应用后继续，身份与记录会保留。</div>}
    {(error||snapshot?.error)&&<div className="df-error" role="alert"><span>{error||snapshot?.error}</span><Button size="sm" onClick={()=>{void refresh().catch(()=>{});}}>刷新状态</Button></div>}
    <main className="df-main">
    {!snapshot?<div className="df-empty"><p>正在连接搭子本地服务…</p></div>:versionMismatch?<section className="df-empty"><h2>重启应用以完成更新</h2><p>当前界面与后台版本不同，暂时停止发言。身份与记录会保留，重启后用原口令解锁。</p></section>:identityPrompt&&snapshot.identity!=='ready'?<><Button size="sm" variant="ghost" onClick={()=>{setIdentityPrompt(false);setView('lobby');setPendingRequest(undefined);}}>返回大厅</Button><IdentityGate snapshot={snapshot} call={call} busy={busy}/></>:view==='lobby'?<Lobby key={snapshot.selectedRoom} room={snapshot.selectedRoom} onRoom={room=>void selectRoom(room)} onHistory={async()=>{try{const value=await invoke('lobby.history',{room:snapshot.selectedRoom});if(mounted.current)setSnapshot(value as Snapshot);}catch(cause){setError(cause instanceof Error?cause.message:'历史暂未载入，请重试。');throw cause;}}} snapshot={snapshot} busy={busy||versionMismatch} draft={lobbyDraft} setDraft={setLobbyDraft} reply={lobbyReply} setReply={setLobbyReply} onConnect={()=>setModal({type:'network'})} onIdentity={()=>void prepareAndSend()} onPerson={p=>setModal({type:'person',peer:p})} onSend={sendPublic} onRetry={()=>act('lobby.retry')}/>:view==='discover'?<section className="df-page">
      <header className="df-head"><h1>发现搭子</h1><div className="df-actions"><small className="df-muted">{snapshot.discoverable?snapshot.published?'名片已发布':'名片待同步':'名片未公开'}</small><Button size="sm" variant="ghost" disabled={busy} onClick={()=>snapshot.discoverable?act('discovery.visibility',{visible:false,confirmed:true}):setModal({type:'discovery'})}>{snapshot.discoverable?'停止被发现':'开启被发现'}</Button></div></header>
      <div className="df-tools"><input className="df-search" aria-label="搜索搭子" placeholder="搜索昵称或兴趣" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/><select aria-label="兴趣筛选" value={tag} onChange={e=>{setTag(e.target.value);setPage(1);}}><option value="">全部兴趣</option>{tags.map(t=><option key={t}>{t}</option>)}</select><span className="df-count">已同步 {filtered.length} 位</span></div>
      <div className="df-list">{shown.map(p=><article className="df-person" key={p.publicKey}>{personButton(p)}<div className="df-person-body"><p className="df-bio">{p.bio||p.looking||'这个搭子还没有填写介绍。'}</p><div className="df-tags">{p.tags.map(t=><span key={t}>{t}</span>)}</div></div><div className="df-person-action"><small>近期活跃</small><Button size="sm" variant="outline" disabled={busy||outgoing.some(i=>i.peer===p.publicKey)} onClick={()=>snapshot.friends.some(f=>f.publicKey===p.publicKey)?openChat(p):setModal({type:'request',peer:p})}>{snapshot.friends.some(f=>f.publicKey===p.publicKey)?'聊一聊':outgoing.some(i=>i.peer===p.publicKey)?'邀请待确认':'发起私聊'}</Button></div></article>)}</div>
      {!shown.length&&<div className="df-empty"><h2>{snapshot.networkApproved?'还没有找到搭子':'社区尚未连接'}</h2><p>{snapshot.networkApproved?'这里只显示共同中继上主动加入、且近期活跃的名片。可以调整搜索条件。':'连接公共中继后可以发现同好。你的名片仍由你决定是否公开。'}</p><Button variant="outline" onClick={()=>snapshot.networkApproved?setView('settings'):setModal({type:'network'})}>{snapshot.networkApproved?'查看连接状态':'连接社区'}</Button></div>}
      {filtered.length>0&&<div className="df-pages"><span>每页 6 位 · 已同步 {filtered.length} 位</span><div><Button size="sm" variant="outline" disabled={current<=1} onClick={()=>setPage(current-1)}>上一页</Button><span>{current} / {count}</span><Button size="sm" variant="outline" disabled={current>=count} onClick={()=>setPage(current+1)}>下一页</Button></div></div>}
    </section>:view==='friends'?<section className="df-page"><header className="df-head"><h1>联系人</h1><Button size="sm" onClick={()=>setView('discover')}>发现搭子</Button></header>{snapshot.identity==='locked'&&<p className="df-status">本机旧版联系人和私聊仍受保护，尚未读取；记录没有清空。可到“我”中恢复。</p>}<h2>收到的私聊申请 · {incoming.length}</h2>
      {incoming.map(i=><div className="df-row" key={i.id}><div className="df-invite-copy"><strong>{snapshot.peers.find(p=>p.publicKey===i.peer)?.name??short(i.peer)}</strong><p>{i.greeting}</p><small className="df-muted">{short(i.peer)}</small></div><div className="df-actions"><Button size="sm" disabled={busy} onClick={()=>act('friend.ignore',{id:i.id})}>忽略</Button><Button size="sm" variant="outline" disabled={busy} onClick={()=>act('friend.accept',{id:i.id})}>接受邀请</Button></div></div>)}
      {!incoming.length&&<p className="df-status">暂无待处理邀请。</p>}<h2 className="df-subheading">联系人 · {snapshot.friends.length}</h2>{snapshot.friends.map(p=><div className="df-row" key={p.publicKey}>{personButton(p)}<Button size="sm" variant="outline" onClick={()=>openChat(p)}>聊一聊</Button></div>)}{!snapshot.friends.length&&<p className="df-status">双方确认邀请后，就可以在这里聊天。</p>}
      {outgoing.length>0&&<><h2 className="df-subheading">发出的邀请 · {outgoing.length}</h2>{outgoing.map(i=><div className="df-row" key={i.id}><div>{short(i.peer)}<p>{i.greeting}</p></div><small className="df-muted">{snapshot.pendingIds.includes(i.id)?'等待发出，可到设置重试':'等待对方确认'}</small></div>)}</>}
    </section>:view==='messages'?<div className={`df-messenger ${threadOpen?'thread-open':''}`}><aside className="df-contacts" aria-label="好友会话">{snapshot.friends.map(p=><button key={p.publicKey} className="df-contact" aria-current={selected===p.publicKey?'true':undefined} onClick={()=>{setSelected(p.publicKey);setThreadOpen(true);setLimit(100);}}><Avatar publicKey={p.publicKey}/><span>{p.name}<small>{short(p.publicKey)}</small></span></button>)}{!snapshot.friends.length&&<div className="df-empty"><p>{snapshot.identity==='locked'?'本机旧版私聊尚未恢复，可到“我”中处理；原记录仍保留。':'还没有好友会话。'}</p><Button size="sm" onClick={()=>setView('discover')}>发现搭子</Button></div>}</aside><section className="df-thread">
      {!peer?<div className="df-empty"><p>选择一位好友开始聊天。</p></div>:<><header className="df-thread-head"><Button className="df-back" size="sm" onClick={()=>setThreadOpen(false)}>返回</Button><Avatar publicKey={peer.publicKey}/><strong>{peer.name}</strong><div className="df-actions"><Button size="sm" onClick={()=>setModal({type:'person',peer})}>名片</Button></div></header><div className="df-history" ref={history}>
      <p className="df-status">人与人的加密私聊。“已到中继”不代表对方已读。</p>{messages.length>limit&&<Button size="sm" onClick={()=>setLimit(limit+100)}>加载更早消息</Button>}{messages.slice(-limit).map(m=><div key={`${m.mine}:${m.id}`} className={`df-chat-row ${m.mine?'mine':''}`}><Avatar publicKey={m.mine?snapshot.publicKey:peer.publicKey}/><div className="df-chat-copy"><div className="df-bubble">{m.text}</div><small>{new Date(m.createdAt*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} · {messageStates[m.status]}</small>{m.status==='failed'&&<Button size="sm" disabled={busy} onClick={()=>act('message.retry')}>重试待发</Button>}</div></div>)}</div>
      {snapshot.blocked.includes(selected)?<div className="df-compose"><p>已屏蔽此搭子，暂不可发送消息。</p></div>:<form className="df-compose" onSubmit={event=>void send(event)}><textarea aria-label="消息内容" maxLength={2000} value={drafts[selected]??''} placeholder="和搭子聊一聊…" onChange={e=>setDrafts({...drafts,[selected]:e.target.value})} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/><div><span>Enter 发送 · Shift + Enter 换行</span><Button variant="outline" size="sm" type="submit" disabled={busy||!drafts[selected]?.trim()}>发送</Button></div></form>}</>}
    </section></div>:<section className="df-page"><header className="df-head"><h1>我</h1><Button size="sm" disabled={busy} onClick={()=>act('identity.lock')}>锁定身份</Button></header><div className="df-settings"><div><section className="df-section"><h2>我的名片</h2><ProfileForm profile={snapshot.profile} call={async(endpoint,payload)=>{if(snapshot.identity!=='ready')await call('identity.local');return call(endpoint,payload);}} busy={busy}/></section><section className="df-section"><h2>提醒</h2><p>应用隐藏或最小化时，可分别提醒新消息和有人进入当前公共房间。</p><div className="df-actions"><Button size="sm" variant="outline" onClick={()=>void toggleNotifications()}>{snapshot.notificationsEnabled?'关闭新消息提醒':'开启新消息提醒'}</Button><Button size="sm" variant="outline" onClick={()=>void toggleEntryNotifications()}>{snapshot.entryNotificationsEnabled?'关闭进房提醒':'开启进房提醒'}</Button></div></section><section className="df-section"><h2>可见性</h2><p>公开昵称、简介、兴趣与近期活跃时间。关闭后停止续租，已经发布的副本无法保证从互联网删除。</p><Button variant="outline" size="sm" disabled={busy} onClick={()=>snapshot.discoverable?act('discovery.visibility',{visible:false,confirmed:true}):setModal({type:'discovery'})}>{snapshot.discoverable?'停止被发现':'开启被发现'}</Button></section><section className="df-section"><h2>已屏蔽 · {snapshot.blocked.length}</h2>{snapshot.blocked.map(key=><div className="df-row" key={key}><small>{short(key)}</small><Button size="sm" disabled={busy} onClick={()=>act('friend.block',{peer:key,blocked:false})}>解除屏蔽</Button></div>)}</section></div><aside><section className="df-section"><h2>社区连接</h2>{snapshot.relays.map(r=><div className="df-relay-wrap" key={r.url}><div className="df-relay"><span>{new URL(r.url).hostname}</span><small title={r.detail}>{states[r.state]}{snapshot.identity==='ready'?r.privateState==='ready'?' · 私聊就绪':r.privateState==='authenticating'?' · 验证中':r.privateState==='failed'?' · 私聊待重连':'':''}</small></div>{(r.route||r.detail)&&<p className="df-relay-detail">{r.route&&<span>{r.route} · </span>}{r.detail||(r.state==='connected'?'已连接':r.state==='connecting'?'正在连接…':'等待连接')}</p>}</div>)}<p>{(snapshot.historyPolicy==='memory-24h')?'大厅只在内存缓存每房间最近100条、最多24小时，重启清空；私聊只转发。聊天不落盘，运营统计会留存。':'公共中继由第三方运营。连接成功不代表名片已发布或私信接收已准备好。'}</p><div className="df-actions"><Button size="sm" variant="outline" disabled={busy} onClick={()=>snapshot.networkApproved?act('network.connect',{confirmed:true}):setModal({type:'network'})}>{snapshot.networkApproved?'重新连接':'连接社区'}</Button>{snapshot.networkApproved&&<Button size="sm" disabled={busy} onClick={()=>act('network.disconnect')}>断开</Button>}</div>{snapshot.pending>0&&<p>有 {snapshot.pending} 项待发。<Button size="sm" disabled={busy} onClick={()=>act('message.retry')}>重试待发</Button></p>}</section><section className="df-section"><h2>本机使用</h2><p>{snapshot.localIdentity?'本机身份由系统安全存储保管，重新进入自动恢复，无需填写口令。':snapshot.identity==='missing'?'浏览和查看历史无需设置身份，首次发言时自动准备本机身份。':'已有身份和聊天记录已保留。旧版加密身份可在高级恢复中处理。'}</p><details className="df-advanced"><summary>高级恢复与身份信息</summary><div className="df-key">{snapshot.publicKey??'尚未准备发言身份'}</div>{snapshot.localIdentity?<p>本机身份暂不提供跨设备备份导出。聊天记录按各自的缓存与加密存储规则保存。</p>:snapshot.identity==='locked'?<Button size="sm" variant="outline" onClick={()=>setIdentityPrompt(true)}>旧版身份恢复</Button>:snapshot.identity==='ready'?<><Button size="sm" variant="outline" onClick={()=>void backup()} disabled={busy}>下载旧版加密备份</Button><Button size="sm" variant="outline" onClick={()=>act('identity.local')} disabled={busy}>启用本机自动恢复</Button></>:null}</details></section><p className="df-status">插件不会读取你的 AI 对话、工作区或模型配置，也不会执行好友发送的内容。</p></aside></div></section>}
    </main>
    <dialog ref={dialog} onCancel={()=>setModal(undefined)}><header className="df-dialog-head"><h2>{modal?.type==='network'?'连接社区':modal?.type==='discovery'?'开启被发现':modal?.type==='person'?'搭子名片':'发起私聊'}</h2><Button size="sm" onClick={()=>setModal(undefined)}>关闭</Button></header>
    {modal?.type==='network'?<><p>连接后即可浏览公共聊天室，无需注册或设置口令。发送的正文和昵称对参与者可见，完整名片仍由你选择是否公开。默认连接 relay.techflag.cn：大厅在内存缓存每房间最近100条、最多24小时，重启清空；私聊只转发。聊天不写磁盘，运营统计与脱敏标识会留存；公开名片与路由在内存短暂保留。插件不会分享你的 AI 对话、文件或工作区。</p><div className="df-dialog-actions">{snapshot?.networkApproved&&<Button disabled={busy} onClick={()=>{setModal(undefined);act('network.disconnect');}}>断开连接</Button>}<Button variant="outline" disabled={busy} onClick={()=>{setModal(undefined);act('network.connect',{confirmed:true});}}>{snapshot?.networkApproved?'重新连接':'同意并连接'}</Button></div></>:modal?.type==='discovery'?<><p>向共同中继公开：昵称、简介、兴趣、公开身份标识、近期活跃时间，以及用于接收加密邀请的中继配置。</p><p>不会发布 DSH 对话或文件。可以随时停止发布，互联网副本可能保留。</p><div className="df-dialog-actions"><Button disabled={busy} onClick={()=>setModal(undefined)}>取消</Button><Button variant="outline" disabled={busy} onClick={()=>{setModal(undefined);void(async()=>{if(!snapshot?.networkApproved)await call('network.connect',{confirmed:true});if(snapshot?.identity!=='ready')await call('identity.local');await call('discovery.visibility',{visible:true,confirmed:true});})().catch(()=>{});}}>同意并公开</Button></div></>:modal?.type==='person'&&modal.peer?<><Avatar publicKey={modal.peer.publicKey} size="large"/><strong>{modal.peer.name}</strong><p>{modal.peer.bio||'尚未填写介绍。'}</p><div className="df-key">{modal.peer.publicKey}</div><p>昵称由对方填写，公钥用于核对身份，不代表官方认证。</p><div className="df-dialog-actions"><Button disabled={busy} onClick={()=>{const key=modal.peer!.publicKey;setModal(undefined);act('friend.block',{peer:key,blocked:!snapshot?.blocked.includes(key)});}}>{snapshot?.blocked.includes(modal.peer.publicKey)?'解除屏蔽':'屏蔽此搭子'}</Button>{modal.peer.publicKey!==snapshot?.publicKey&&<Button variant="outline" disabled={busy} onClick={()=>{const p=modal.peer!;if(snapshot?.friends.some(f=>f.publicKey===p.publicKey)){openChat(p);setModal(undefined);}else requestPrivate(p);}}>{snapshot?.friends.some(p=>p.publicKey===modal.peer!.publicKey)?'聊一聊':'发起私聊'}</Button>}</div></>:modal?.type==='request'&&modal.peer?<form onSubmit={event=>{event.preventDefault();const target=modal.peer!.publicKey;void call('friend.request',{peer:target,text:greeting,id:crypto.randomUUID()}).then(()=>{setModal(undefined);setGreeting('');}).catch(()=>{});}}><p>向 {modal.peer.name} 介绍一下你自己，对方接受后再开始聊天。</p><label className="df-field">打个招呼<textarea required maxLength={120} rows={3} value={greeting} onChange={e=>setGreeting(e.target.value)}/></label><div className="df-dialog-actions"><Button type="submit" variant="outline" disabled={busy||!greeting.trim()}>发送邀请</Button></div></form>:null}
    </dialog>
  </div>;
}

export const name='dsh-friends-client';
export const inject=['slots','layout','connection'];
export function apply(ctx:Context){
  const lifetime=new AbortController();
  const invoke:Call=async(endpoint,payload={})=>{
    const signal=AbortSignal.any([lifetime.signal,AbortSignal.timeout(35_000)]);
    const response=await fetch(new URL('./api/dsh-friends',document.baseURI),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload}),signal});
    const result=await response.json() as {ok:boolean;value?:unknown;error?:{message?:string}};
    if(!result.ok)throw new Error(result.error?.message??'DSH 本地连接未就绪，请刷新后重试。');return result.value;
  };
  ctx.effect(()=>()=>lifetime.abort(),'dsh-friends.client');
  let noticeRevision:number|undefined;
  const notifier=new MessageNotifications(async()=>{const batch=await invoke(noticeRevision===undefined?'notifications.poll':'notifications.wait',noticeRevision===undefined?{}:{after:noticeRevision}) as NoticeBatch;if(typeof batch.revision!=='number')throw Error('通知后台版本尚未就绪');noticeRevision=batch.revision;return batch;},item=>document.visibilityState==='visible'&&document.hasFocus()&&ctx.layout.panelInfo.getSnapshot().activePanelId==='dsh-friends'&&(item.room?readingConversation.view==='lobby'&&readingConversation.room===item.room:readingConversation.view==='messages'&&readingConversation.peer===item.peer),item=>{window.focus();ctx.layout.selectPanel('dsh-friends' as MainPanelId);const open=()=>window.dispatchEvent(new CustomEvent('dsh-friends:open-notice',{detail:item}));if(item.room)void invoke('room.select',{room:item.room}).then(open).catch(()=>{});else open();},message=>window.dispatchEvent(new CustomEvent('dsh-friends:notification-error',{detail:message})));
  notifier.start();ctx.effect(()=>()=>notifier.stop(),'dsh-friends.notifications');
  ctx.slots.inject('main',()=>ctx.slots.inject('sidebar.panellist',()=>{
    const panel=ctx.slots.register({name:'main',key:'dsh-friends'},()=> <FriendsApp invoke={invoke}/>);
    let entry:()=>void;
    try{entry=ctx.slots.register({name:'sidebar.panellist',id:'dsh-friends',label:'搭子',order:60},({size}:{size:number})=><svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4h13v10H8l-5 4V4Z"/><path d="M16 9h5v12l-4-3h-6v-4"/></svg>);}catch(error){panel();throw error;}
    return()=>{try{if(ctx.layout.panelInfo.getSnapshot().activePanelId==='dsh-friends')ctx.layout.selectPanel(null);}finally{entry();panel();}};
  }));
}
