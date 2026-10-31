import{chromium}from'@playwright/test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{readFile,writeFile}from'node:fs/promises';import{execFileSync}from'node:child_process';
assert.equal(process.env.DSH_FRIENDS_ALLOW_PUBLIC_TEST,'1');
const report={checks:[],passed:false,scope:'Actual close buttons of isolated installed macOS Desktop processes; not a claim about other OS builds.'},browsers=[];
async function api(p,endpoint,payload={}){const r=await p.evaluate(async body=>(await(await fetch(new URL('./api/dsh-friends',document.baseURI),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json()),{endpoint,payload});assert(r.ok,r.error?.message);return r.value;}
async function until(fn){const end=Date.now()+35000;for(;;){const r=await fn();if(r)return r;if(Date.now()>end)throw Error('lifecycle deadline');await new Promise(r=>setTimeout(r,350));}}
const os=(pid,script)=>{assert(Number.isInteger(pid));return execFileSync('osascript',['-e',`tell application "System Events" to tell (first application process whose unix id is ${pid}) to ${script}`],{encoding:'utf8'}).trim();};
try{
 const records=JSON.parse(await readFile('.artifacts/rooms-desktop-processes.json','utf8'));
 for(const port of[18831,18832])browsers.push(await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:6000}));
 const official=browsers[0].contexts()[0].pages()[0],work=browsers[1].contexts()[0].pages()[0];
 for(const p of[official,work])assert((await api(p,'snapshot')).profile.name.startsWith('隔离桌面测试'));
 await api(official,'notifications.set',{enabled:true});
 const binding='_dshCloseProof'+Date.now();await official.exposeFunction(binding,row=>{if(row.title.includes('插件交流'))report.officialNotification=row;});await official.evaluate(binding=>{const Original=Notification;window.Notification=class extends Original{constructor(title,options){super(title,options);this.addEventListener('show',()=>window[binding]({title,shown:true}));}};},binding);
 await official.bringToFront();
 const officialPid=records.find(r=>r.port===18831).pid;
 os(officialPid,'click (first button of front window whose subrole is "AXCloseButton")');
 await until(async()=>os(officialPid,'count windows')==='0');assert(!official.isClosed());report.checks.push('official Desktop close button hides its window while keeping the renderer alive');
 const text='关闭窗口后台收信验收 '+String(Date.now()).slice(-6)+'（合成测试）';
 await api(work,'lobby.send',{id:randomUUID(),room:'builders',text,confirmed:true});
 await until(async()=>report.officialNotification);report.checks.push('official Desktop actually receives and shows a system notification after closing its window');
 // WorkDSH currently destroys its renderer on the macOS close button.
 await work.bringToFront();
 const workPid=records.find(r=>r.port===18832).pid;
 os(workPid,'set value of attribute "AXMinimized" of front window to false');
 const origin=await work.evaluate(()=>location.origin);
 os(workPid,'click (first button of front window whose subrole is "AXCloseButton")');
 await until(async()=>work.isClosed());
 const response=await browsers[1].contexts()[0].request.post(origin+'/api/dsh-friends',{data:{endpoint:'snapshot'},timeout:10000});const state=await response.json();
 report.workdsh={rendererClosed:work.isClosed(),hostAlive:response.ok()&&state.ok,notificationWatcherAlive:false};
 assert(report.workdsh.hostAlive);report.checks.push('WorkDSH close destroys the renderer but keeps the macOS Host alive; renderer notifications cannot continue');
 report.passed=true;
}catch(e){report.failure=e.message;process.exitCode=1;}
finally{await writeFile('.artifacts/desktop-lifecycle-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));for(const b of browsers)await b.close();}
