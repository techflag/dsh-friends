import{chromium}from'@playwright/test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{writeFile,readFile}from'node:fs/promises';import{execFileSync}from'node:child_process';
assert.equal(process.env.DSH_FRIENDS_ALLOW_PUBLIC_TEST,'1');
const report={checks:[],scope:'Actual installed isolated macOS WorkDSH and official DSH; public relay, synthetic identities.',passed:false},connections=[];
async function api(p,endpoint,payload={}){const r=await p.evaluate(async body=>(await(await fetch(new URL('./api/dsh-friends',document.baseURI),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json()),{endpoint,payload});assert(r.ok,r.error?.message);return r.value;}
async function until(fn){const end=Date.now()+40000;for(;;){const r=await fn();if(r)return r;if(Date.now()>end)throw Error('notification deadline');await new Promise(r=>setTimeout(r,400));}}
try{
 for(const port of[18831,18832])connections.push(await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:5000}));
 const a=connections[0].contexts()[0].pages()[0],b=connections[1].contexts()[0].pages()[0];
 for(const p of[a,b]){await p.getByRole('button',{name:'搭子',exact:true}).waitFor({timeout:25000});const s=await api(p,'snapshot');assert(s.profile.name.startsWith('隔离桌面测试'));assert.equal(s.runtimeRevision,'rooms-history-notifications-2');if(s.identity==='locked')await api(p,'identity.unlock',{password:'dsh-friends-rooms-acceptance-only-2026'});await p.keyboard.press('Escape');}
 await b.getByRole('button',{name:'搭子',exact:true}).click();
 const binding='_dshNoticeProof'+Date.now();await b.exposeFunction(binding,row=>{if(row.title.includes('随便聊聊'))report.notification=row;});
 await b.evaluate(binding=>{const Original=window.Notification;window.Notification=class extends Original{constructor(title,options){super(title,options);this.addEventListener('show',()=>window[binding]({title,body:options.body,shown:true}));}};},binding);
 const toggle=b.locator('.dsh-friends').getByRole('button',{name:'新消息提醒',exact:true});if(!(await api(b,'snapshot')).notificationsEnabled){await until(async()=>await toggle.getAttribute('aria-pressed')==='false');await toggle.click();}await until(async()=>(await api(b,'snapshot')).notificationsEnabled);report.checks.push('native user action enables opt-in standard notifications');
 // Moving away from the plugin must not stop its notification watcher.
 await b.getByRole('button',{name:'插件',exact:true}).click();
 await b.bringToFront();
 const records=JSON.parse(await readFile('.artifacts/rooms-desktop-processes.json','utf8')),pid=records.find(row=>row.port===18832).pid;assert(Number.isInteger(pid));
 execFileSync('osascript',['-e',`tell application "System Events" to tell (first application process whose unix id is ${pid}) to set value of attribute "AXMinimized" of front window to true`]);
 report.osMinimized=execFileSync('osascript',['-e',`tell application "System Events" to tell (first application process whose unix id is ${pid}) to get value of attribute "AXMinimized" of front window`],{encoding:'utf8'}).trim();assert.equal(report.osMinimized,'true');
 const text='最小化通知验收 '+String(Date.now()).slice(-6)+'（合成测试）';const s=await api(a,'lobby.send',{id:randomUUID(),room:'random',text,confirmed:true});assert.equal(s.lobby.find(p=>p.text===text).status,'relay-accepted');
 await until(async()=>report.notification);report.osMinimizedAfter=execFileSync('osascript',['-e',`tell application "System Events" to tell (first application process whose unix id is ${pid}) to get value of attribute "AXMinimized" of front window`],{encoding:'utf8'}).trim();
 report.checks.push('actual OS Notification show event after a live public message with the plugin panel closed and Desktop minimized');
 assert(!report.notification.body.includes(text));report.checks.push('system notification does not reveal message text');
 execFileSync('osascript',['-e',`tell application "System Events" to tell (first application process whose unix id is ${pid}) to set value of attribute "AXMinimized" of front window to false`]);
 report.passed=true;
}catch(e){report.failure=e.message;process.exitCode=1;}finally{await writeFile('.artifacts/desktop-notifications-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));for(const b of connections)await b.close();}
