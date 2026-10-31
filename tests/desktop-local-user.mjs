import{chromium}from'@playwright/test';import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';import{openSync,closeSync}from'node:fs';import{resolve}from'node:path';import{spawn,execFileSync}from'node:child_process';
assert.equal(process.env.DSH_FRIENDS_ALLOW_PUBLIC_TEST,'1','This opt-in test sends one labelled public message.');
const report={checks:[],passed:false,scope:'Fresh isolated installed official macOS DSH Desktop; actual Keychain, UI actions, public relay, full process restart.'};let browser;
const recordPath='.artifacts/local-user-desktop-process.json',record=JSON.parse(await readFile(recordPath,'utf8'));
async function until(fn,label){const end=Date.now()+45000;for(;;){const r=await fn();if(r)return r;if(Date.now()>end)throw Error('Timeout: '+label);await new Promise(r=>setTimeout(r,350));}}
async function attach(){await until(async()=>{try{const r=await fetch('http://127.0.0.1:18833/json/version');return r.ok;}catch{return false;}},'Desktop debug listener');browser=await chromium.connectOverCDP('http://127.0.0.1:18833',{timeout:6000});const context=browser.contexts()[0];if(!context.pages().length){assert(Number.isInteger(record.pid));execFileSync('osascript',['-l','JavaScript','-e',`ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${record.pid}).activateWithOptions(3);`]);}return context.pages()[0]??await context.waitForEvent('page',{timeout:15000});}
async function api(page,endpoint,payload={}){const r=await page.evaluate(async body=>(await(await fetch(new URL('./api/dsh-friends',document.baseURI),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json()),{endpoint,payload});assert(r.ok,r.error?.message);return r.value;}
try{
 let page=await attach();await page.getByRole('button',{name:'插件',exact:true}).waitFor({timeout:30000});await page.keyboard.press('Escape');
 if(!await page.getByRole('button',{name:'搭子',exact:true}).count()){
  await page.getByRole('button',{name:'插件',exact:true}).click();
  const enable=page.getByRole('button',{name:'立即启用',exact:true});
  if(!await enable.isVisible().catch(()=>false)){
   await page.getByRole('button',{name:'添加插件',exact:true}).click();await page.getByRole('textbox',{name:'包名或地址',exact:true}).fill(resolve('.artifacts/rooms-candidate/dsh-friends-0.1.0-alpha.7.tgz'));await page.getByRole('button',{name:'安装',exact:true}).click();
   await enable.waitFor({timeout:45000});
  }
  await enable.click();
 }
 await page.getByRole('button',{name:'搭子',exact:true}).waitFor({timeout:45000});await page.getByRole('button',{name:'搭子',exact:true}).click();let root=page.locator('.dsh-friends');
 assert.equal((await api(page,'snapshot')).identity,'missing');
 await root.getByRole('button',{name:'进入大厅',exact:true}).click();await root.getByRole('button',{name:'同意并连接',exact:true}).click();await until(async()=>(await api(page,'snapshot')).lobby.length>0,'existing public history');assert.equal((await api(page,'snapshot')).identity,'missing');report.checks.push('a new user reads actual public chat history without creating an identity');
 await root.locator('.df-nav').getByRole('button',{name:'我',exact:true}).click();assert.equal(await root.locator('input[type=password]:visible').count(),0);await root.getByRole('heading',{name:'我的名片',exact:true}).waitFor();assert.equal((await api(page,'snapshot')).identity,'missing');report.checks.push('settings and connection information open without identity or password forms');
 await root.locator('.df-nav').getByRole('button',{name:'社区',exact:true}).click();await root.getByRole('button',{name:'# 随便聊聊',exact:true}).click();await root.getByRole('heading',{name:'# 随便聊聊',exact:true}).waitFor();
 const roomBox=await root.locator('.df-room-list').boundingBox(),streamBox=await root.locator('.df-lobby-history').boundingBox();assert(roomBox.y<streamBox.y);assert(roomBox.width>streamBox.width*.9);report.checks.push('the native plugin uses top room navigation and the conversation below it');
 const text='本机免口令发言验收 '+String(Date.now()).slice(-6)+'（合成测试）';await root.getByRole('textbox',{name:'大厅发言',exact:true}).fill(text);
 const response=page.waitForResponse(r=>r.url().endsWith('/api/dsh-friends')&&r.request().postDataJSON()?.endpoint==='lobby.send',{timeout:35000});await root.getByRole('button',{name:'发送',exact:true}).click();assert((await(await response).json()).ok);
 const first=await api(page,'snapshot');assert.equal(first.identity,'ready');assert(first.localIdentity);assert.equal(first.lobby.find(p=>p.text===text).status,'relay-accepted');assert.equal(await root.locator('input[type=password]:visible').count(),0);report.publicKey=first.publicKey;report.checks.push('one Send click prepares a protected local identity and publishes the actual message without account/password entry');
 await root.screenshot({path:'docs/images/native-vertical-local-user.png'});
 const executable='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',args=execFileSync('ps',['-p',String(record.pid),'-o','args='],{encoding:'utf8'});assert(args.includes(record.home));await browser.close();browser=undefined;process.kill(record.pid,'SIGTERM');
 await until(async()=>{try{process.kill(record.pid,0);return false;}catch{return true;}},'owned Desktop shutdown');
 const fd=openSync('.artifacts/local-user-desktop.log','a',0o600),env={...process.env,DSH_HOME:record.home+'/dsh-home',HTTPS_PROXY:'http://127.0.0.1:7890',HTTP_PROXY:'http://127.0.0.1:7890',NO_PROXY:'127.0.0.1,localhost'};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(executable,['--remote-debugging-port=18833','--user-data-dir='+record.home+'/user-data'],{env,stdio:['ignore',fd,fd],detached:true});child.unref();closeSync(fd);record.pid=child.pid;await writeFile(recordPath,JSON.stringify(record,null,2));
 page=await attach();await page.getByRole('button',{name:'搭子',exact:true}).waitFor({timeout:30000});await page.getByRole('button',{name:'搭子',exact:true}).click();root=page.locator('.dsh-friends');const restored=await until(async()=>{const s=await api(page,'snapshot');return s.identity==='ready'?s:false;},'automatic identity restore');assert.equal(restored.publicKey,first.publicKey);assert(restored.lobby.some(p=>p.text===text));assert.equal(await root.locator('input[type=password]:visible').count(),0);report.checks.push('a full native Desktop restart automatically restores the same identity and cached message without password entry');report.passed=true;
}catch(e){report.failure=e.message;process.exitCode=1;}
finally{await writeFile('.artifacts/desktop-local-user-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(browser)await browser.close();}
