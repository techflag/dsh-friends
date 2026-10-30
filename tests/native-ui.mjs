import { chromium, request } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const log=await readFile(process.env.DSH_FRIENDS_NATIVE_LOG||'.artifacts/native-runtime.log','utf8');
const url=log.match(/http:\/\/127\.0\.0\.1:18807\/\?token=[^\s]+/)?.[0];
assert(url,'Start the isolated official DSH acceptance runtime first.');
assert(!log.includes('did not activate'),'Native plugin activation failed.');
const base='http://127.0.0.1:18807',password='native-ui-test-password-12345';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage(),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
async function check(name,fn){await fn();checks.push(name);console.log(`PASS ${name}`);}
async function api(endpoint,payload={}){
  const response=await context.request.post(`${base}/api/dsh-friends`,{headers:{origin:base},data:{endpoint,payload}});
  const result=await response.json();assert(result.ok,result.error?.message);return result.value;
}
async function commandResponse(endpoint,action){
  const response=page.waitForResponse(r=>r.url().endsWith('/api/dsh-friends')&&r.request().postDataJSON()?.endpoint===endpoint);
  await action();const result=await(await response).json();assert(result.ok,result.error?.message);return result.value;
}
async function settle(){await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().iterations)).map(a=>a.finished.catch(()=>{}))));}
try{
  await mkdir('docs/images',{recursive:true});
  await page.goto(url);
  await page.getByRole('button',{name:'搭子',exact:true}).waitFor();
  const notice=page.getByRole('button',{name:'Continue',exact:true});
  const noticeVisible=await notice.waitFor({state:'visible',timeout:5000}).then(()=>true,()=>false);
  if(noticeVisible){await notice.click();await notice.waitFor({state:'hidden'});}
  // A clean official profile can show its model onboarding after the notice.
  // DSH permits closing it; this plugin never needs a model key or paid call.
  const onboardingClose=page.getByRole('button',{name:'Close',exact:true});
  const onboardingVisible=await onboardingClose.waitFor({state:'visible',timeout:3000}).then(()=>true,()=>false);
  if(onboardingVisible)await onboardingClose.click();
  await page.getByRole('button',{name:'搭子',exact:true}).click();
  const root=page.locator('.dsh-friends');await root.waitFor();
  await check('official DSH sidebar opens the independent plugin, with no mock shell',async()=>{
    assert.equal(await page.getByRole('button',{name:'New session',exact:true}).count()>0,true);
    const state=await api('snapshot');
    if(state.identity==='missing'){
      await root.getByLabel('昵称',{exact:true}).fill('原生接入测试');
      await root.getByLabel('备份口令',{exact:true}).fill(password);
      await root.getByLabel('再次输入口令',{exact:true}).fill(password);
      await commandResponse('identity.create',()=>root.getByRole('button',{name:'创建身份',exact:true}).click());
    }else if(state.identity==='locked'){
      await root.getByLabel('解锁口令',{exact:true}).fill(password);
      await commandResponse('identity.unlock',()=>root.getByRole('button',{name:'解锁',exact:true}).click());
    }
    await root.getByRole('heading',{name:'发现搭子',exact:true}).waitFor();
    assert.equal((await api('snapshot')).identity,'ready');
  });
  await check('native Host data is real, with no fixture people or automatic publication',async()=>{
    const state=await api('snapshot');assert.equal(state.discoverable,false);assert.equal(state.networkApproved,false);assert.equal(state.peers.length,0);
    assert.equal(await root.locator('.df-person').count(),0);
    await root.getByRole('button',{name:'设置',exact:true}).click();
    await root.getByLabel('昵称',{exact:true}).fill('DSH 原生验收');
    await commandResponse('profile.update',()=>root.getByRole('button',{name:'保存名片',exact:true}).click());
    assert.equal((await api('snapshot')).profile.name,'DSH 原生验收');
  });
  await check('identity backup is a real encrypted download',async()=>{
    const downloading=page.waitForEvent('download');
    await root.getByRole('button',{name:'下载加密身份备份'}).click();
    const download=await downloading;await download.saveAs('.artifacts/native-test-identity-backup.txt');
    const backup=await readFile('.artifacts/native-test-identity-backup.txt','utf8');assert(backup.startsWith('ncryptsec1'));
    assert.equal(JSON.stringify(await api('snapshot')).includes(backup),false);
  });
  await check('locking, a wrong password and unlocking preserve the saved profile',async()=>{
    await commandResponse('identity.lock',()=>root.getByRole('button',{name:'锁定身份'}).click());
    await root.getByRole('heading',{name:'解锁搭子身份'}).waitFor();
    await root.getByLabel('解锁口令').fill('wrong-password');
    const failed=page.waitForResponse(r=>r.url().endsWith('/api/dsh-friends')&&r.request().postDataJSON()?.endpoint==='identity.unlock');
    await root.getByRole('button',{name:'解锁',exact:true}).click();assert.equal((await(await failed).json()).ok,false);
    assert.equal((await api('snapshot')).identity,'locked');
    await root.getByLabel('解锁口令').fill(password);
    await commandResponse('identity.unlock',()=>root.getByRole('button',{name:'解锁',exact:true}).click());
    assert.equal((await api('snapshot')).profile.name,'DSH 原生验收');
  });
  await check('official authentication fences anonymous and cross-origin access',async()=>{
    const anonymous=await request.newContext();
    try{const response=await anonymous.post(`${base}/api/dsh-friends`,{data:{endpoint:'snapshot',payload:{}}});assert([401,403].includes(response.status()));}finally{await anonymous.dispose();}
    const response=await context.request.post(`${base}/api/dsh-friends`,{headers:{origin:'https://example.invalid'},data:{endpoint:'snapshot',payload:{}}});assert.equal(response.status(),403);
  });
  await root.getByRole('button',{name:'发现',exact:true}).click();await settle();
  await page.screenshot({path:'docs/images/native-dsh-light.png'});
  await check('plugin follows the actual available DSH panel width',async()=>{
    await page.setViewportSize({width:660,height:800});await settle();
    assert.equal(await root.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    await page.screenshot({path:'docs/images/native-dsh-narrow.png'});
    await page.setViewportSize({width:1440,height:1000});
  });
  await check('official DSH appearance settings control plugin colors and readable primary buttons',async()=>{
    const light=await root.evaluate(el=>getComputedStyle(el).backgroundColor);
    async function appearance(name){
      await page.getByRole('button',{name:'Account menu',exact:true}).click();
      await page.getByText('Settings',{exact:true}).click();
      await page.getByRole('button',{name,exact:true}).click();
      await page.getByRole('button',{name:'Close',exact:true}).click();await settle();
    }
    await appearance('Dark');
    await page.waitForFunction(color=>getComputedStyle(document.querySelector('.dsh-friends')).backgroundColor!==color,light);
    await page.screenshot({path:'docs/images/native-dsh-dark.png'});
    await root.getByRole('button',{name:'设置',exact:true}).click();
    await commandResponse('identity.lock',()=>root.getByRole('button',{name:'锁定身份'}).click());
    const colors=await root.getByRole('button',{name:'解锁',exact:true}).evaluate(el=>({text:getComputedStyle(el).color,fill:getComputedStyle(el).backgroundColor}));
    const luminance=color=>{const c=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;});return c[0]*0.2126+c[1]*0.7152+c[2]*0.0722;};
    const a=luminance(colors.text),b=luminance(colors.fill);assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,'Primary action text must have readable native-theme contrast');
    await root.getByLabel('解锁口令').fill(password);
    await commandResponse('identity.unlock',()=>root.getByRole('button',{name:'解锁',exact:true}).click());
    await appearance('Light');
    await page.waitForFunction(color=>getComputedStyle(document.querySelector('.dsh-friends')).backgroundColor===color,light);
    await root.getByRole('button',{name:'发现',exact:true}).click();
  });
  await check('native UI connects to public relays without publishing a profile',async()=>{
    await root.getByRole('button',{name:'连接社区',exact:true}).click();
    await commandResponse('network.connect',()=>root.getByRole('button',{name:'同意并连接',exact:true}).click());
    const connected=await api('snapshot');assert.equal(connected.networkApproved,true);assert.equal(connected.discoverable,false);assert.equal(connected.published,false);
    assert(connected.relays.some(r=>r.state==='connected'),'At least one candidate should be reachable through the isolated DSH proxy policy.');
    await api('network.disconnect');
  });
  assert.deepEqual(errors,[]);
  await writeFile('.artifacts/native-ui-verification.json',JSON.stringify({checks,errors,scope:'Official DSH 0.2.1-rc.5 Web with isolated synthetic data. No public announcements or model calls.'},null,2));
  console.log(`${checks.length} real native UI checks passed.`);
}finally{await browser.close();}
