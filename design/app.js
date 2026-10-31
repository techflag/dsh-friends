(() => {
  'use strict';
  document.documentElement.dataset.theme='light';
  const people = window.FRIENDS_FIXTURES;
  const returning = new URLSearchParams(location.search).get('scenario')==='returning';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    replyThread:'<path d="M6 4h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-5 4V7a3 3 0 0 1 2-3Z"/><path d="M8 9h8M8 13h5"/>',
    reply:'<path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7"/>',
    lobby:'<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
    discover:'<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5M11 7v8M7 11h8"/>',
    messages:'<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M7 8h10M7 12h6"/>',
    friends:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
    settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface)"/><circle cx="15" cy="17" r="3" fill="var(--surface)"/>',
    search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
    edit:'<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
    arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
    lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
    shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>',
    chevron:'<path d="m14 5-7 7 7 7"/>',
    wave:'<path d="M2 12h4l3-7 6 14 3-7h4"/>',
    eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    send:'<path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.messages}</svg>`;
  const state = {
    view:'lobby', tag:'全部', query:'', onlineOnly:false, page:1, size:6,
    profile:{name:'林间', bio:'用 DSH 做点顺手的小工具，期待认识有相同兴趣的朋友。', tags:'插件开发、效率工具'},
    discoverable:false, network:'normal', requests:returning?['e']:[], outgoing:new Set(),
    friends:new Set(returning?people.filter(p => p.friend).map(p => p.id):[]), blocked:new Set(),
    selected:'a', unread:new Set(returning?['a','c']:[]), threadOpen:false, messages:{}, drafts:{},
    lobbyPosts:structuredClone(window.FRIENDS_LOBBY_FIXTURES), lobbyReply:null, lobbyDraft:'', roomChannel:'general', channelDrafts:{}, channelReplies:{}, channelScrolls:{}, restoreChannelScroll:false,
  };
  const footer = () => '';
  const avatar = (p, size='') => `<span class="avatar ${p.tone || 'self'} ${size}" aria-hidden="true"><img src="avatars/${/^[a-l]$/.test(p.id||'')?p.id:'self'}.svg" alt="" width="40" height="40" draggable="false"></span>`;
  const status = p => `<span class="status"><span class="dot ${p.online ? '' : 'amber'}"></span>${esc(p.seen)}</span>`;
  let toastTimeout;
  function toast(message) {
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 4400);
  }
  function navigate(view) {
    if (location.hash === `#${view}`) render();
    else location.hash = view;
  }
  function updateRail() {
    const activeView=state.view==='discover'?'friends':state.view;
    $('#rail-name').textContent = state.profile.name;
    $('#rail-visibility').textContent = state.discoverable ? '演示：允许被发现' : '名片尚未公开';
    $('#navigation').innerHTML = [['lobby','社区'],['messages','私信'],['friends','联系人'],['settings','我']].map(([key,label]) => `<a href="#${key}" class="nav-item ${activeView === key ? 'active' : ''}" ${activeView === key ? 'aria-current="page"' : ''} aria-label="${label}" ${key==='lobby'?'data-action="community-home"':''}>${icon(key)}<span class="nav-label">${label}</span>${key === 'messages' && state.unread.size ? `<span class="count">${state.unread.size}</span>` : key === 'friends' && state.requests.length ? `<span class="count">${state.requests.length}</span>` : ''}</a>`).join('');
  }
  function personCard(p) {
    const blocked = state.blocked.has(p.id);
    const friend = state.friends.has(p.id);
    const pending = state.outgoing.has(p.id);
    return `<article class="person-card" data-person="${p.id}">
      <div class="person-top">${avatar(p)}<div class="person-title"><button class="name-button" data-action="person" data-id="${p.id}">${esc(p.name)}</button><p class="person-role">${esc(p.role)}</p></div></div>
      <div class="person-content"><p class="person-bio">${esc(p.bio)}</p><div class="tags">${p.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}<span class="looking-inline">${esc(p.looking)}</span></div></div>
      <div class="person-actions">${status(p)}<button class="button ${friend ? 'soft' : ''}" data-action="${friend ? 'chat' : 'request'}" data-id="${p.id}" ${pending || blocked ? 'disabled' : ''}>${blocked ? '已屏蔽' : friend ? '聊一聊' : pending ? '已发出邀请' : '发起私聊'}</button></div>
    </article>`;
  }
  function matchesPeople() {
    const q = state.query.trim().toLowerCase();
    return people.filter(p=> !state.blocked.has(p.id) && (!state.onlineOnly || p.online) && (state.tag === '全部' || p.tags.includes(state.tag)) && (!q || [p.name,p.role,p.bio,...p.tags,p.looking].some(s=>s.toLowerCase().includes(q))));
  }
  function renderDiscoveryResults() {
    const results = matchesPeople();
    const totalPages = Math.max(1,Math.ceil(results.length / state.size));
    state.page = Math.min(Math.max(1,state.page),totalPages);
    const current = results.slice((state.page - 1)*state.size,state.page*state.size);
    $('#result-count').textContent = `${results.length} 位搭子 · 演示名片`;
    $('#people-results').innerHTML = current.length ? `<div class="people-list">${current.map(personCard).join('')}</div>` : `<div class="empty">${icon('search')}<h3>还没有找到合适的搭子</h3><p>试试其他关键词，或查看所有兴趣。</p><button class="button" data-action="reset-search">清除筛选</button></div>`;
    $('#pagination').innerHTML = `<span>${results.length ? `第 ${(state.page-1)*state.size+1}–${Math.min(state.page*state.size,results.length)} 位，共 ${results.length} 位` : '0 位搭子'}</span><div class="page-controls" aria-label="发现列表分页"><button data-action="page" data-page="${state.page-1}" aria-label="上一页" ${state.page===1?'disabled':''}>‹</button>${Array.from({length:totalPages},(_,i)=>`<button data-action="page" data-page="${i+1}" aria-label="第 ${i+1} 页" ${state.page===i+1?'aria-current="page"':''}>${i+1}</button>`).join('')}<button data-action="page" data-page="${state.page+1}" aria-label="下一页" ${state.page===totalPages?'disabled':''}>›</button></div>`;
  }
  const roomChannels=[{id:'general',name:'大厅',topic:'第一次见面也没关系，聊聊你正在做的事。'},{id:'builders',name:'插件交流',topic:'分享小工具，讨论一个值得解决的问题。'},{id:'random',name:'随便聊聊',topic:'工作之外，也欢迎聊聊生活。'}];
  state.lobbyPosts.push({id:'builders-1',room:'builders',author:'a',time:'14:10',text:'最近在做一个本地文件整理插件。你们最想把哪件小事交给 AI？'},{id:'builders-2',room:'builders',author:'b',time:'14:12',text:'我想从旅行清单开始，小一点，做完能天天用。'},{id:'random-1',room:'random',author:'d',time:'14:05',text:'有人喜欢边听音乐边写东西吗？今天的循环歌单很不错。'});
  function rememberChannelPosition(){const stream=$('.lobby-stream');if(stream)state.channelScrolls[state.roomChannel]=stream.scrollTop;}
  state.lobbyPosts.push({id:'self-demo',author:'self',time:'14:27',replyTo:'l3',text:'我也想先做一个能一直用的小工具，大家可以互相试试。'});
  function lobby() {
    const author=post=>post.author==='self'?{name:state.profile.name}:people.find(p=>p.id===post.author);
    const channel=roomChannels.find(c=>c.id===state.roomChannel),posts=state.lobbyPosts.filter(p=>(p.room||'general')===channel.id),reply=posts.find(p=>p.id===state.lobbyReply);
    const guests=[...new Set(posts.map(p=>p.author))].map(id=>author(posts.find(p=>p.author===id)));
    function row(post){const person=author(post),parent=posts.find(p=>p.id===post.replyTo),mine=post.author==='self';return `<article class="lobby-post ${mine?'mine':''}" data-post="${post.id}">${avatar(person,'small')}<div class="lobby-post-body"><div class="slack-author">${mine?`<strong>${esc(person.name)} <small>我</small></strong>`:`<button class="name-button" data-action="person" data-id="${post.author}">${esc(person.name)}</button>`}<time>${esc(post.time)}</time></div><div class="lobby-bubble">${parent?`<button class="room-message-quote" data-action="jump-message" data-id="${parent.id}" aria-label="查看${esc(author(parent).name)}的原消息"><b>${esc(author(parent).name)}</b><span>${esc(parent.text)}</span></button>`:''}<p>${esc(post.text)}</p></div></div><button class="text-button room-reply" data-action="lobby-reply" data-id="${post.id}" aria-label="回复${esc(person.name)}">${icon('reply')}</button></article>`;}
    $('#community-search').value='';$('#community-search').placeholder='搜索当前房间';$('#community-search').setAttribute('aria-label','搜索当前房间');
    $('#main').innerHTML=`<section class="lobby-page room-layout slack-layout flat-room ${state.roomPeople?'room-show-people':''}"><aside class="room-list"><div class="room-brand">DSH 搭子 <small>一个属于 DSH 使用者的小社区</small></div><h2>公共聊天室 <small>演示</small></h2>${roomChannels.map(c=>`<button class="room-selected ${c.id===channel.id?'active':''}" data-action="channel" data-id="${c.id}" ${c.id===channel.id?'aria-current="true"':''}># &nbsp;${c.name}</button>`).join('')}<div class="room-note"><b>公开交流</b><p>先在房间里聊聊。想单独交流时，点击对方头像发起私聊。</p><small>原型演示 · 未连接公共网络</small></div></aside><div class="room-center"><header class="page-head"><div><h1><span class="room-hash">#</span> ${esc(channel.name)}</h1><p class="subtitle">${esc(channel.topic)}</p></div><div class="room-head-actions"><button class="text-button slack-channel-menu" data-action="choose-channel" aria-label="切换频道">⌄</button><button class="text-button" data-action="room-people" aria-label="查看频道成员">${guests.slice(0,3).map(p=>avatar(p,'small')).join('')}<span>${guests.length}</span></button></div></header><div class="lobby-stream" aria-label="大厅聊天记录"><div class="room-welcome"><span>今天</span></div>${posts.map(row).join('')}</div><form id="lobby-composer" class="lobby-composer">${reply?`<div class="lobby-reply-target"><span><b>回复 ${esc(author(reply).name)}</b><small>${esc(reply.text)}</small></span><button type="button" class="text-button" data-action="cancel-lobby-reply" aria-label="取消回复">×</button></div>`:''}<button type="button" class="slack-input-plus" data-action="message-tools" aria-label="消息工具" aria-expanded="false">＋</button><div class="slack-input-menu" id="message-tools-menu" hidden><span>消息工具</span><button type="button" data-action="message-emoji">☺ &nbsp; 插入表情</button><button type="button" data-action="message-format" data-id="bold"><b>B</b> &nbsp; 粗体标记</button><button type="button" data-action="message-format" data-id="italic"><i>I</i> &nbsp; 斜体标记</button><button type="button" data-action="message-format" data-id="code">&lt;/&gt; &nbsp; 代码标记</button></div><label class="sr-only" for="lobby-input">在大厅公开发言</label><textarea id="lobby-input" maxlength="2000" placeholder="发消息到 #${esc(channel.name)}">${esc(state.lobbyDraft)}</textarea><div class="composer-bottom"><div class="slack-editor-actions"><button type="button" data-action="message-emoji" aria-label="插入表情">☺</button><button type="button" data-action="room-people" aria-label="查看可交流的成员">@</button><small>Enter 发送</small></div><button type="submit" class="button primary slack-send-icon" aria-label="发言（演示）" title="发送消息" ${state.lobbyDraft.trim()?'':'disabled'}>${icon('send')}</button></div></form></div><aside class="room-people"><header><b>房间成员 ${guests.length}</b><button class="text-button" data-action="room-people" aria-label="返回聊天">×</button></header><p>演示名单 · 不代表真实在线</p>${guests.map(p=>`<button class="room-person" data-action="${p.id?'person':'profile'}" ${p.id?`data-id="${p.id}"`:''}>${avatar(p,'small')}<span><b>${esc(p.name)}</b><small>${p.id?'演示人物':'这是你'}</small></span></button>`).join('')}</aside></section>`;
    const stream=$('.lobby-stream');stream.scrollTop=state.channelScrolls[channel.id]??stream.scrollHeight;
    stream.addEventListener('scroll',()=>{state.channelScrolls[channel.id]=stream.scrollTop;},{passive:true});
  }
  function postToLobby(){
    const input=$('#lobby-input'),text=input?.value.trim();if(!text)return;
    state.lobbyPosts.push({id:crypto.randomUUID(),author:'self',room:state.roomChannel,text,replyTo:state.lobbyReply,time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})});
    state.lobbyReply=null;state.lobbyDraft='';lobby();$('.lobby-stream').scrollTop=$('.lobby-stream').scrollHeight;$('#lobby-input').focus();
  }
  function discover() {
    const categories = ['全部','插件开发','效率工具','产品设计','内容创作','教育学习','日常交流'];
    $('#community-search').value='';
    $('#main').innerHTML = `<div class="page">
      <header class="page-head"><h1>发现搭子</h1><div class="header-actions"><span class="muted visibility-summary">${state.discoverable ? '演示：名片可被发现' : '名片未公开'}</span><button class="text-button" data-action="visibility">${state.discoverable ? '管理可见性' : '开启被发现 →'}</button></div></header>
      <section class="discovery" aria-label="搭子列表"><div class="toolbar"><label class="search">${icon('search')}<input id="people-search" aria-label="搜索搭子" placeholder="搜索昵称或兴趣" value="${esc(state.query)}"></label><select id="interest-filter" aria-label="兴趣筛选">${categories.map(t=>`<option ${state.tag===t?'selected':''}>${t}</option>`).join('')}</select><label class="check-label"><input id="online-only" type="checkbox" ${state.onlineOnly?'checked':''}>近期在线</label><span id="result-count" class="result-count"></span></div><div id="people-results"></div><div id="pagination" class="pagination"></div></section></div>`;
    renderDiscoveryResults();
  }
  function messages() {
    const contacts = people.filter(p=>state.friends.has(p.id));
    if (!contacts.some(p=>p.id===state.selected)) state.selected = contacts[0]?.id;
    const p = contacts.find(p=>p.id===state.selected);
    $('#community-search').value='';
    $('#main').innerHTML = `<div class="message-page ${state.threadOpen ? 'thread-open' : ''}"><header class="page-head"><div><div class="eyebrow">A CONVERSATION BETWEEN FRIENDS</div><h1>私信</h1><p class="subtitle">和搭子继续聊聊。这里是人与人的私聊。</p></div><div class="mood-line">${icon('lock')}私聊界面预览 · 尚未接入加密通信</div></header><div class="messenger"><aside class="contact-list" aria-label="好友会话"><label class="search">${icon('search')}<input id="contact-search" aria-label="搜索好友会话" placeholder="搜索好友"></label><div class="list-caption">最近会话</div><div id="contacts">${contacts.map(c=>`<button class="contact ${state.selected===c.id?'selected':''}" data-action="select-contact" data-id="${c.id}" aria-label="与${esc(c.name)}聊天">${avatar(c)}<span class="contact-copy"><span class="contact-line"><strong>${esc(c.name)}</strong><small>${esc(c.time || '刚刚')}</small></span><p>${state.blocked.has(c.id)?'已屏蔽':esc(state.messages[c.id]?.at(-1)?.text || c.note || '成为了好友，打个招呼吧。')}</p></span>${state.unread.has(c.id)?'<span class="dot"></span>':''}</button>`).join('') || '<div class="contact-list-empty"><p>还没有私聊</p><small>先去公共频道，看看大家在聊什么。</small><button class="button" data-action="lobby">去公共大厅</button></div>'}</div></aside>${p ? `<section class="thread" aria-label="与${esc(p.name)}的聊天"><div class="thread-head"><button class="icon-button chat-back" data-action="back-contacts" aria-label="返回会话列表">${icon('chevron')}</button>${avatar(p,'small')}<div><strong>${esc(p.name)}</strong>${status(p)}</div><button class="icon-button" data-action="person" data-id="${p.id}" aria-label="查看${esc(p.name)}的名片">${icon('friends')}</button></div><div class="thread-scroll" id="thread-scroll"></div><div id="compose-area"></div></section>` : '<section class="empty message-empty"><span class="empty-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H9l-5 4Z"/></svg></span><h3>聊得来，再单独聊</h3><p>先在大厅认识有共同话题的人，想继续聊时再发起私聊。</p><button class="button" data-action="lobby">去大厅聊聊</button></section>'}</div></div>`;
    if(p) renderThread();
  }
  function renderThread() {
    const p = people.find(p=>p.id===state.selected);
    if (!state.messages[p.id]) state.messages[p.id]=[
      { text:`你好，我是${p.name}。看到你也在用 DSH，想和你交流一下做小工具的经验。`, mine:false, time:'14:28' },
      { text:'你好呀！我也刚开始尝试，最近在做一个管理自己旅行的小插件。', mine:true, time:'14:30', status:'演示记录' },
      { text:p.note || '我们可以先分享一下各自的想法。', mine:false, time:p.time || '14:32' },
    ];
    $('#thread-scroll').innerHTML = `<p class="chat-caption">${icon('lock')} 本地演示消息，不会发送给任何人</p><div class="chat-date">今天 · 示例对话</div>${state.messages[p.id].map((m,i)=>`<div class="message-row ${m.mine?'mine':''}">${avatar(m.mine ? {mark:'我'} : p,'small')}<div class="bubble-wrap"><div class="private-author"><strong>${esc(m.mine?state.profile.name:p.name)}</strong><time>${esc(m.time)}</time></div><div class="bubble">${esc(m.text)}</div><div class="message-meta">${m.mine ? `<span>${esc(m.status)}</span>` : ''}${m.status==='演示：发送失败' ? `<button class="text-button" data-action="retry-message" data-index="${i}">重试</button>` : ''}</div></div></div>`).join('')}`;
    $('#compose-area').innerHTML = state.blocked.has(p.id) ? `<div class="thread-blocked"><span>已屏蔽此搭子，暂不接收或发送消息。</span><button class="text-button" data-action="unblock" data-id="${p.id}">解除屏蔽</button></div>` : `<form class="composer" id="composer"><label class="sr-only" for="message-input">给${esc(p.name)}发消息</label><textarea id="message-input" name="message" maxlength="2000" placeholder="说点什么，和搭子聊一聊…">${esc(state.drafts[p.id] || '')}</textarea><div class="composer-bottom"><small>仅本地演示 · Enter 发送 / Shift + Enter 换行</small><button class="button primary slack-send-icon" type="submit" aria-label="发送" title="发送消息">${icon('send')}</button></div></form>`;
    $('#thread-scroll').scrollTop = $('#thread-scroll').scrollHeight;
  }
  function sendMessage() {
    const input = $('#message-input');
    const text = input?.value.trim();
    if (!text || state.blocked.has(state.selected)) return;
    state.messages[state.selected].push({text,mine:true,time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),status:state.network==='offline'?'演示：发送失败':'演示：中继已接收'});
    state.drafts[state.selected]='';
    renderThread();
    $('#message-input')?.focus();
    if(state.network==='offline') toast('模拟连接已断开。草稿已保留为失败消息，可重试。');
  }
  function friends() {
    const list = people.filter(p=>state.friends.has(p.id));
    $('#community-search').value='';
    $('#main').innerHTML = `<div class="page"><header class="page-head"><div><div class="eyebrow">YOUR CIRCLE, AT YOUR PACE</div><h1>联系人</h1><p class="subtitle">从有共同兴趣，到有人可以一起交流。</p></div><button class="button" data-action="discover">${icon('plus')}发现新搭子</button></header><div class="section-title"><h2>私聊申请 <span class="muted">${state.requests.length}</span></h2><span class="muted"><small>邀请仅在本次预览内操作</small></span></div>${state.requests.length ? state.requests.map(id=>{const p=people.find(p=>p.id===id);return `<article class="request-card">${avatar(p)}<div class="request-body"><strong>${esc(p.name)}</strong><p>“我也在学做插件，想和你交流一下从哪里开始。”</p><small class="muted">${p.role} · 示例邀请</small></div><div class="inline-actions"><button class="button" data-action="ignore" data-id="${id}">忽略</button><button class="button primary" data-action="accept" data-id="${id}">接受邀请</button></div></article>`;}).join('') : '<div class="empty invite-empty"><h3>没有待处理的申请</h3><p>有人想和你单独聊时，申请会显示在这里。</p></div>'}<div class="section-title"><h2>联系人 <span class="muted">${list.length}</span></h2></div><div class="friends-list">${list.map(p=>`<article class="friend-row">${avatar(p)}<div><button class="name-button" data-action="person" data-id="${p.id}">${esc(p.name)}</button><p>${state.blocked.has(p.id)?'已屏蔽':esc(p.role)}</p></div><button class="button" data-action="chat" data-id="${p.id}">聊一聊</button></article>`).join('')}</div>${!list.length?'<div class="empty contacts-empty"><span class="empty-symbol" aria-hidden="true">♧</span><h3>从大厅里的一次交流开始</h3><p>聊得来的人，可以在这里继续联系。</p><button class="button primary" data-action="lobby">去大厅认识搭子</button></div>':''}${footer()}</div>`;
  }
  function switchControl(id, checked, label) {
    return `<label class="switch"><input id="${id}" type="checkbox" ${checked?'checked':''} aria-label="${label}"><span></span></label>`;
  }
  function settings() {
    $('#community-search').value='';
    $('#main').innerHTML = `<div class="page"><header class="page-head"><div><div class="eyebrow">CONNECTED, ON YOUR TERMS</div><h1>连接与隐私</h1><p class="subtitle">是否被发现、与谁交流，都由你决定。</p></div></header><div class="settings-grid"><div><section class="section-card"><h2>我的名片</h2><p class="subtitle">昵称与简介是自己填写的信息，不代表身份认证。</p><form id="profile-form"><div class="form-row">${avatar({mark:'我'},'large')}<div><strong>${esc(state.profile.name)}</strong><p>本地插画头像 · 原型演示身份</p></div></div><label class="field">昵称<input name="name" required maxlength="20" value="${esc(state.profile.name)}"></label><label class="field">一句话介绍<textarea name="bio" rows="3" maxlength="160">${esc(state.profile.bio)}</textarea></label><label class="field">我的兴趣<input name="tags" maxlength="60" value="${esc(state.profile.tags)}"><small>用顿号分隔，最多 3 个兴趣。</small></label><button class="button primary" type="submit">保存名片（演示）</button></form></section><section class="section-card"><h2>可见性</h2><p class="subtitle">默认不公开。开启后，共同中继上的其他用户可以看到你的名片。</p><div class="toggle-row"><div><strong>允许其他搭子发现我</strong><small>公开昵称、简介、兴趣和近期活跃时间。正式版会先列出这些信息，由你确认。</small></div>${switchControl('discoverable',state.discoverable,'允许其他搭子发现我')}</div><p class="setting-note">关闭后停止公开活跃公告。过去已发布的名片可能仍被中继或其他人保留，无法保证从互联网彻底删除。</p></section><section class="section-card"><h2>已屏蔽的搭子</h2><p class="subtitle">屏蔽只影响本插件的展示和收取，不会通知对方。</p>${state.blocked.size ? [...state.blocked].map(id=>`<div class="blocked-row"><span>${esc(people.find(p=>p.id===id).name)}</span><button class="text-button" data-action="unblock" data-id="${id}">解除屏蔽</button></div>`).join('') : '<p class="setting-note">还没有屏蔽任何人。</p>'}</section></div><aside><section class="section-card"><h2>社区连接</h2><p class="subtitle">下列是接入候选，当前没有真实连接。</p>${['relay.damus.io','relay.primal.net','nos.lol'].map((r,i)=>`<div class="relay-row"><span>${r}</span><small>${state.network==='offline'?'模拟断开':state.network==='partial'&&i===2?'模拟不可用':'尚未实测'}</small></div>`).join('')}<label class="field"><span>预览网络状态</span><select id="network-state" class="network-select"><option value="normal" ${state.network==='normal'?'selected':''}>正常场景（模拟）</option><option value="partial" ${state.network==='partial'?'selected':''}>部分中继不可用（模拟）</option><option value="offline" ${state.network==='offline'?'selected':''}>全部断开（模拟）</option></select></label><p class="setting-note">可以切换到“全部断开”，再去消息页体验发送失败与重试。</p></section><section class="section-card"><h2>身份与恢复</h2><p class="subtitle">支持的设备会自动保管本机发言身份。</p><div class="code">DEMO-ID · 本预览没有生成真实密钥</div><p class="setting-note">Mac 插件已接入系统钥匙串，重开自动恢复；此预览不生成真实身份。其他系统尚未验证。</p><button class="text-button" data-action="identity-help">了解身份与备份 →</button></section><section class="section-card"><h2>这里会分享什么？</h2><p class="setting-note">大厅发言是公开内容；私聊单独加密。完整名片只有你选择加入同好名片列表后才发布。DSH 对话、文件、模型配置和工作区不会自动分享。</p><p class="setting-note">插件私聊单独加密。当前页面为离线演示，不向公共网络发送内容。</p></section></aside></div>${footer()}</div>`;
  }
  function render() {
    state.view = ['lobby','discover','messages','friends','settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'lobby';
    const search=$('#community-search'),label=({lobby:'搜索当前频道',discover:'搜索昵称或兴趣',messages:'搜索私聊',friends:'搜索联系人'})[state.view];search.closest('label').hidden=state.view==='settings';search.disabled=!label;if(label){search.placeholder=label;search.setAttribute('aria-label',label);}
    updateRail();
    ({lobby,discover,messages,friends,settings})[state.view]();
    document.title = `DSH 搭子 · ${{lobby:'大厅',discover:'发现搭子',messages:'私信',friends:'联系人',settings:'连接与隐私'}[state.view]} · 设计预览`;
  }
  function openDialog(title, body, actions='') {
    const dialog = $('#dialog');
    dialog.innerHTML = `<div class="dialog-body"><div class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="关闭弹窗">${icon('close')}</button></div>${body}${actions ? `<div class="dialog-actions">${actions}</div>` : ''}</div>`;
    if(!dialog.open) dialog.showModal();
  }
  function visibilityDialog() {
    if(state.discoverable) return navigate('settings');
    openDialog('让同路人发现你', '<p>开启后，正式版会向选定的公共中继发布以下信息。这里先用演示数据体验，不会连接网络。</p><ul class="detail-points"><li>你填写的昵称、简介和兴趣</li><li>插件近期活跃时间</li><li>用于验证名片的公开身份标识</li></ul><p>不会发布 DSH 对话、文件或模型配置。可以随时停止发布；已经公开的内容可能被其他人保留。</p>', '<button class="button" data-action="close-dialog">暂不开启</button><button class="button primary" data-action="confirm-visibility">同意并开启（演示）</button>');
  }
  function personDialog(id) {
    const p=people.find(p=>p.id===id);
    if(!p)return;
    openDialog('搭子名片', `<div class="dialog-profile">${avatar(p,'large')}<div><h3>${esc(p.name)}</h3><p>${esc(p.role)}</p>${status(p)}</div></div><p>${esc(p.bio)}</p><div class="tags">${p.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><div class="looking">${icon('messages')}${esc(p.looking)}</div><div class="code profile-detail-id">演示标识：demo:friends:${p.id}<br>正式版会展示可核对的完整公钥。</div><p>以上为虚构名片。昵称和头像不代表经过身份认证。</p>`, `<button class="button danger" data-action="${state.blocked.has(id)?'unblock':'block'}" data-id="${id}">${state.blocked.has(id)?'解除屏蔽':'屏蔽'}</button><button class="button primary" data-action="${state.friends.has(id)?'chat':'request'}" data-id="${id}" ${state.outgoing.has(id)?'disabled':''}>${state.friends.has(id)?'聊一聊':state.outgoing.has(id)?'已发出邀请':'发起私聊'}</button>`);
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if(!button || button.disabled)return;
    const action=button.dataset.action, id=button.dataset.id;
    if(action==='close-dialog')return $('#dialog').close();
    if(action==='message-tools'){const menu=$('#message-tools-menu');menu.hidden=!menu.hidden;button.setAttribute('aria-expanded',String(!menu.hidden));return;}
    if(action==='message-format'){$('#message-tools-menu').hidden=true;document.querySelector('.slack-input-plus').setAttribute('aria-expanded','false');const input=$('#lobby-input'),mark=id==='bold'?'**':id==='italic'?'_':'`',start=input.selectionStart,end=input.selectionEnd,value=input.value.slice(start,end)||'文字';input.setRangeText(mark+value+mark,start,end,'end');state.lobbyDraft=input.value;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();return;}
    if(action==='message-emoji'){$('#message-tools-menu').hidden=true;document.querySelector('.slack-input-plus').setAttribute('aria-expanded','false');const input=$('#lobby-input');input.setRangeText(' 👋 ',input.selectionStart,input.selectionEnd,'end');state.lobbyDraft=input.value;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();return;}
    if(action==='choose-channel')return openDialog('切换频道','<p>以下频道仅用于离线原型体验。</p>',roomChannels.map(c=>`<button class="button" data-action="channel" data-id="${c.id}"># ${esc(c.name)}</button>`).join(''));
    if(action==='channel'){rememberChannelPosition();state.restoreChannelScroll=true;$('#dialog').close();state.channelDrafts[state.roomChannel]=state.lobbyDraft;state.channelReplies[state.roomChannel]=state.lobbyReply;state.roomChannel=id;state.lobbyDraft=state.channelDrafts[id]||'';state.lobbyReply=state.channelReplies[id]||null;state.roomPeople=false;lobby();return;}
    if(action==='open-view')return navigate(id);
    if(action==='community-home'){event.preventDefault();$('#dialog').close();state.restoreChannelScroll=true;state.roomPeople=false;navigate('lobby');return;}
    if(action==='room-people'){state.roomPeople=!state.roomPeople;lobby();return;}
    if(action==='lobby'){ $('#dialog').close();return navigate('lobby'); }
    if(action==='lobby-reply'){rememberChannelPosition();state.lobbyReply=id;lobby();$('#lobby-input').focus();return;}
    if(action==='jump-message'){const target=document.querySelector(`[data-post="${id}"]`);if(target){target.scrollIntoView({block:'center',behavior:'smooth'});target.classList.add('quote-located');setTimeout(()=>target.classList.remove('quote-located'),1600);}return;}
    if(action==='cancel-lobby-reply'){rememberChannelPosition();state.lobbyReply=null;lobby();return;}
    if(action==='settings' || action==='discover')return navigate(action);
    if(action==='profile'){ $('#dialog').close();navigate('settings');return; }
    if(action==='person')return personDialog(id);
    if(action==='visibility')return visibilityDialog();
    if(action==='confirm-visibility'){state.discoverable=true;$('#dialog').close();render();toast('已在本地演示中开启；没有向公共中继发布信息。');return;}
    if(action==='tag'){state.tag=button.dataset.tag;state.page=1;discover();return;}
    if(action==='page'){state.page=Number(button.dataset.page);renderDiscoveryResults();$('#people-results').scrollIntoView({block:'start',behavior:'auto'});$('#announcer').textContent=`第 ${state.page} 页`;return;}
    if(action==='reset-search'){state.tag='全部';state.query='';state.onlineOnly=false;state.page=1;discover();return;}
    if(action==='request'){
      if(state.blocked.has(id))return;
      const p=people.find(p=>p.id===id);
      return openDialog(`认识一下${esc(p.name)}`, `<p>附上一句介绍，对方同意后，再单独聊聊刚才的话题。</p><form id="request-form" data-id="${id}"><label class="field">打个招呼<textarea name="greeting" rows="3" maxlength="120" required placeholder="你好，看到你也在用 DSH，想和你交流一下…"></textarea></label><small class="muted">设计预览：邀请只记录在本次页面中，不会真实发送。</small><div class="dialog-actions"><button class="button" type="button" data-action="close-dialog">取消</button><button class="button primary" type="submit">发送私聊申请（演示）</button></div></form>`);
    }
    if(action==='accept'){state.friends.add(id);state.requests=state.requests.filter(x=>x!==id);render();toast('已在演示中成为好友，可以开始聊天。');return;}
    if(action==='ignore'){state.requests=state.requests.filter(x=>x!==id);render();toast('已忽略演示邀请。');return;}
    if(action==='chat' || action==='select-contact'){
      $('#dialog').close();state.selected=id;state.threadOpen=true;state.unread.delete(id);
      if(state.view==='messages'){messages();updateRail();}else navigate('messages');return;
    }
    if(action==='back-contacts'){state.threadOpen=false;messages();return;}
    if(action==='block')return openDialog('屏蔽这位搭子？','<p>本插件会隐藏此人的名片，不再显示收到的消息，也不能向其发送。已有本地聊天不会删除。</p>',`<button class="button" data-action="close-dialog">取消</button><button class="button danger" data-action="confirm-block" data-id="${id}">确认屏蔽</button>`);
    if(action==='confirm-block'){state.blocked.add(id);state.requests=state.requests.filter(x=>x!==id);$('#dialog').close();render();toast('已在本地演示中屏蔽。');return;}
    if(action==='unblock'){state.blocked.delete(id);$('#dialog').close();render();toast('已解除演示屏蔽。');return;}
    if(action==='retry-message'){state.messages[state.selected][Number(button.dataset.index)].status=state.network==='offline'?'演示：发送失败':'演示：中继已接收';renderThread();toast(state.network==='offline'?'模拟网络仍然断开。可以到设置切换网络场景。':'模拟重试成功；不代表真实发送或对方已读。');return;}
    if(action==='identity-help')return openDialog('身份属于你自己','<p>正式版的身份由密钥控制，昵称可以更改。备份丢失且原设备不可用时，无法通过手机号或项目作者找回。</p><p>这份原型不生成私钥，也不提供伪装成真实备份的下载按钮。下一阶段会先验证 DSH Host 的安全存储，再实现加密备份、导入与恢复。</p>','<button class="button primary" data-action="close-dialog">知道了</button>');
  });
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(!$('#community-search').disabled)$('#community-search').focus();}});
  document.addEventListener('input',event=>{
    if(event.target.id==='community-search'){const q=event.target.value.trim().toLowerCase();if(state.view==='discover'){$('#people-search').value=event.target.value;state.query=event.target.value;state.page=1;renderDiscoveryResults();}else{const selector=state.view==='messages'?'.contact':state.view==='friends'?'.friend-row':'.lobby-post';document.querySelectorAll(selector).forEach(row=>{row.hidden=!row.textContent.toLowerCase().includes(q);});}}
    if(event.target.id==='people-search'){state.query=event.target.value;state.page=1;renderDiscoveryResults();}
    if(event.target.id==='lobby-input'){state.lobbyDraft=event.target.value;$('#lobby-composer button[type=submit]').disabled=!event.target.value.trim();}
    if(event.target.id==='message-input')state.drafts[state.selected]=event.target.value;
    if(event.target.id==='contact-search'){
      const query=event.target.value.trim().toLowerCase();
      document.querySelectorAll('.contact').forEach(el=>{el.hidden=!el.getAttribute('aria-label').toLowerCase().includes(query);});
    }
  });
  document.addEventListener('change',event=>{
    if(event.target.id==='interest-filter'){state.tag=event.target.value;state.page=1;renderDiscoveryResults();}
    if(event.target.id==='online-only'){state.onlineOnly=event.target.checked;state.page=1;renderDiscoveryResults();}
    if(event.target.id==='discoverable'){
      if(event.target.checked){event.target.checked=false;visibilityDialog();}
      else{state.discoverable=false;render();toast('演示：已停止公开；已发布内容无法保证从其他副本删除。');}
    }
    if(event.target.id==='network-state'){state.network=event.target.value;settings();toast('已切换模拟场景，真实网络未连接。');}
    if(event.target.id==='theme'){
      const value=event.target.value;
      if(value==='system')document.documentElement.removeAttribute('data-theme');
      else document.documentElement.dataset.theme=value;
    }
  });
  document.addEventListener('submit',event=>{
    if(event.target.id==='lobby-composer'){event.preventDefault();postToLobby();}
    if(event.target.id==='composer'){event.preventDefault();sendMessage();}
    if(event.target.id==='profile-form'){
      event.preventDefault();const data=new FormData(event.target);const name=String(data.get('name')).trim();
      if(!name)return toast('请填写昵称。');
      state.profile={name,bio:String(data.get('bio')).trim(),tags:String(data.get('tags')).split(/[、,，]/).map(s=>s.trim()).filter(Boolean).slice(0,3).join('、')};
      updateRail();settings();toast('演示名片已更新，仅在本次预览中保留。');
    }
    if(event.target.id==='request-form'){
      event.preventDefault();state.outgoing.add(event.target.dataset.id);$('#dialog').close();render();toast('已记录演示邀请，等待对方接受；没有真实发送。');
    }
  });
  document.addEventListener('keydown',event=>{
    if(event.target.id==='lobby-input' && event.key==='Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();postToLobby();}
    if(event.target.id==='message-input' && event.key==='Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();sendMessage();}
  });
  $('#intro-button').addEventListener('click',()=>openDialog('先聊起来，再认识彼此',`<div class="intro-steps"><div class="intro-step"><span class="step-index">1</span><div><strong>先看看大厅在聊什么</strong><p>不用先找人或加好友，也可以只看不说。</p></div></div><div class="intro-step"><span class="step-index">2</span><div><strong>有共鸣，就跟一句</strong><p>回复一个问题、说说你的想法。正式版在首次发言时再设置昵称与本地身份。</p></div></div><div class="intro-step"><span class="step-index">3</span><div><strong>想继续聊，再转私聊</strong><p>从具体话题认识一个人，联系人关系放在后面。</p></div></div></div><p>当前是离线设计原型，所有人物和发言均为虚构演示。</p>`, '<button class="button primary" data-action="lobby">去大厅看看 →</button>'));
  window.addEventListener('hashchange',()=>{$('#main').scrollTop=0;render();});
  render();
})();
