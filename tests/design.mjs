import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:18806';
const readyUntil=Date.now()+5000;
for(;;){try{const response=await fetch(base);if(response.ok)break;}catch{}if(Date.now()>readyUntil)throw new Error('Design preview did not start');await new Promise(resolve=>setTimeout(resolve,50));}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
const page = await context.newPage();
const errors = [], outbound = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) outbound.push(request.url()); });
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function nav(name) {
  if(name==='发现搭子'){
    await page.getByRole('link', { name:'联系人', exact:true }).click();
    await page.getByRole('button', { name:'发现新搭子', exact:true }).click();
    assert.equal(await page.locator('#navigation a[aria-current=page]').getAttribute('href'),'#friends');
  }else await page.getByRole('link', { name:({'好友':'联系人','设置':'我','消息':'私信'})[name]||name, exact:true }).click();
  await page.getByRole('heading', { name: ({ '发现搭子':'发现搭子', '好友':'联系人', '设置':'连接与隐私', '消息':'私信' })[name], exact:true }).waitFor();
}
async function shot(name) {
  await page.locator('.avatar img').evaluateAll(images=>Promise.all(images.map(image=>image.decode().catch(()=>{}))));
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await page.screenshot({ path: `docs/images/${name}.png`, fullPage: false });
}
try {
  await mkdir('docs/images', { recursive: true });
  await mkdir('.artifacts', { recursive: true });
  await page.goto(base);
  await check('new visitors enter public conversation with zero contacts and can reply without friendship',async()=>{
    await page.getByRole('heading',{name:'# 大厅',exact:true}).waitFor();
    assert.deepEqual(await page.locator('#navigation .nav-label').allTextContents(),['社区','私信','联系人','我']);
    assert.equal(await page.locator('.room-list button').count(),3);
    assert.equal(await page.locator('.room-list').getByRole('button',{name:/联系人|私信|话题/}).count(),0);
    assert.equal(await page.locator('.lobby-post').count(),6);
    assert(await page.locator('.lobby-stream').evaluate(el=>el.scrollHeight<=el.clientHeight+1),'The six demo messages should fit in the desktop conversation viewport');
    assert.equal(await page.locator('textarea:visible').count(),1);
    assert.equal(await page.locator('.slack-replies,.slack-thread').count(),0);
    const mine=await page.locator('.lobby-post.mine').boundingBox(),other=await page.locator('.lobby-post:not(.mine)').first().locator('.lobby-bubble').boundingBox(),own=await page.locator('.lobby-post.mine .lobby-bubble').boundingBox();assert(own.x>other.x);
    await shot('group-chat-light');await shot('lobby-light');
    const box=page.getByRole('textbox',{name:'在大厅公开发言'});
    await box.fill('未发送的公开聊天草稿');
    await page.getByRole('button',{name:'回复阿树',exact:true}).first().click();
    assert.equal(await box.inputValue(),'未发送的公开聊天草稿');
    assert.equal(await page.locator('.lobby-post').count(),6);
    assert.equal(await page.locator('textarea:visible').count(),1);
    await box.fill('回复后仍然在同一个房间');
    await page.getByRole('button',{name:'发言（演示）',exact:true}).click();
    assert.equal(await page.locator('.lobby-post').count(),7);
    const quote=page.locator('.lobby-post').last().getByRole('button',{name:'查看阿树的原消息',exact:true});await quote.click();
    assert.equal(await page.locator('.lobby-post').count(),7);assert.equal(await page.locator('.quote-located').getAttribute('data-post'),'l1');
    await page.getByRole('button',{name:'回复小满',exact:true}).click();await box.fill('大厅的草稿');
    await page.locator('.room-list').getByRole('button',{name:/插件交流/}).click();assert.equal(await box.inputValue(),'');
    await box.fill('插件房间的草稿');await page.locator('.room-list').getByRole('button',{name:/大厅/}).click();
    assert.equal(await box.inputValue(),'大厅的草稿');assert.equal(await page.getByRole('button',{name:'取消回复',exact:true}).count(),1);
    await page.getByRole('button',{name:'取消回复',exact:true}).click();assert.equal(await box.inputValue(),'大厅的草稿');await box.fill('');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#main').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);assert.equal(await page.locator('textarea:visible').count(),1);
    await shot('group-chat-mobile');await page.setViewportSize({width:1280,height:900});
    await page.getByRole('link',{name:'联系人',exact:true}).click();
    assert.equal(await page.locator('.friend-row').count(),0);
    await page.getByRole('link',{name:'私信',exact:true}).click();
    await page.getByRole('button',{name:'去大厅聊聊',exact:true}).click();
    await shot('lobby-fixed-palette');
    if(await page.getByRole('button',{name:'返回频道',exact:true}).isVisible())await page.getByRole('button',{name:'返回频道',exact:true}).click();await page.setViewportSize({width:390,height:844});await shot('lobby-mobile');
    await page.setViewportSize({width:1280,height:900});
  });
  await check('empty messages, contacts, settings and discovery share an opaque readable surface',async()=>{
    await page.goto(base+'/#messages');
    for(const [name,file]of[['消息','messages-empty-light'],['好友','friends-empty-light'],['设置','settings-default-light'],['发现搭子','discover-default-light']]){
      await nav(name);
      assert.equal(await page.locator('#main').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
      assert.equal(await page.locator('h1').evaluate(e=>getComputedStyle(e).color),'rgb(39, 33, 44)');
      const fills=await page.locator('#main .button.primary:not(.slack-send-icon)').evaluateAll(nodes=>nodes.filter(e=>!e.disabled).map(e=>getComputedStyle(e).backgroundColor));assert(fills.every(color=>color==='rgb(117, 64, 141)'),name+' primary action color differs');
      await shot(file);
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.locator('#main').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,name+' empty narrow overflow');
      await page.setViewportSize({width:1280,height:900});
    }
  });
  await page.goto(base+'/?scenario=returning#discover');
  await check('discovery is explicitly a fixture, paginated without losing people', async () => {
    assert.equal(await page.locator('.person-card').count(), 6);
    const first = await page.locator('.person-card').first().getAttribute('data-person');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await page.locator('.person-card').count(), 6);
    assert.notEqual(await page.locator('.person-card').first().getAttribute('data-person'), first);
    assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
  });
  await check('search, empty state, clearing and online filter update visible results', async () => {
    await page.getByRole('textbox', { name: '搜索搭子' }).fill('Momo');
    assert.equal(await page.locator('.person-card').count(), 1);
    await page.getByLabel('近期在线', { exact: true }).check();
    assert.equal(await page.locator('.person-card').count(), 0);
    await page.getByRole('button', { name: '清除筛选' }).click();
    await page.getByLabel('兴趣筛选').selectOption('插件开发');
    assert.equal(await page.locator('.person-card').count(), 4);
    await page.getByLabel('兴趣筛选').selectOption('全部');
  });
  await check('visibility stays private on cancel and requires explicit confirmation', async () => {
    await page.getByRole('button', { name: '开启被发现 →' }).click();
    await page.getByRole('button', { name: '暂不开启' }).click();
    assert.equal(await page.getByText('名片未公开', { exact:true }).count(), 1);
    await page.getByRole('button', { name: '开启被发现 →' }).click();
    await page.getByRole('button', { name: '同意并开启（演示）' }).click();
    await nav('设置');
    assert.equal(await page.getByLabel('允许其他搭子发现我').isChecked(), true);
    await page.getByLabel('允许其他搭子发现我').uncheck();
    await nav('发现搭子');
  });
  await check('invitation has introduction and a non-repeating pending action', async () => {
    await page.locator('[data-person="b"]').getByRole('button', { name: '发起私聊' }).click();
    await page.getByLabel('打个招呼').fill('想交流一下产品设计。');
    await page.getByRole('button', { name: '发送私聊申请（演示）' }).click();
    assert.equal(await page.locator('[data-person="b"]').getByRole('button', { name: '已发出邀请' }).isDisabled(), true);
  });
  await check('accepting a request adds a friend and opens an ordinary human chat', async () => {
    await nav('好友');
    await page.getByRole('button', { name: '接受邀请' }).click();
    assert.equal(await page.locator('.friend-row').count(), 3);
    await page.locator('.friend-row').filter({ hasText: '陈一' }).getByRole('button', { name: '聊一聊' }).click();
    await page.getByRole('textbox', { name: '给陈一发消息' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '给陈一发消息' }).count(), 1);
    await page.getByRole('button', { name: '与阿树聊天' }).click();
  });
  await check('chat draft survives navigation and handles untrusted text as text', async () => {
    const mine=await page.locator('.message-row.mine .avatar').first().boundingBox(),other=await page.locator('.message-row:not(.mine) .avatar').first().boundingBox();assert(mine.x>other.x);
    await page.getByRole('textbox', { name: '给阿树发消息' }).fill('未发送的草稿');
    await nav('发现搭子');
    await nav('消息');
    assert.equal(await page.getByRole('textbox', { name: '给阿树发消息' }).inputValue(), '未发送的草稿');
    await page.getByRole('textbox', { name: '给阿树发消息' }).fill('<img src=x onerror="alert(1)">');
    await page.getByRole('textbox', { name: '给阿树发消息' }).press('Enter');
    assert.equal(await page.locator('.bubble img').count(), 0);
    assert.equal(await page.locator('.bubble').filter({ hasText: '<img src=x onerror="alert(1)">' }).count(), 1);
  });
  await check('offline send preserves the message and retry does not duplicate it', async () => {
    await nav('设置');
    await page.getByLabel('预览网络状态').selectOption('offline');
    await nav('消息');
    await page.getByRole('textbox', { name: '给阿树发消息' }).fill('这条消息在断网后仍然保留');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    assert.equal(await page.getByText('演示：发送失败', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    assert.equal(await page.locator('.bubble').filter({ hasText: '这条消息在断网后仍然保留' }).count(), 1);
    await nav('设置');
    await page.getByLabel('预览网络状态').selectOption('normal');
    await nav('消息');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    assert.equal(await page.getByText('演示：发送失败', { exact: true }).count(), 0);
    assert.equal(await page.locator('.bubble').filter({ hasText: '这条消息在断网后仍然保留' }).count(), 1);
  });
  await check('blocking disables composing and unblocking restores it', async () => {
    await page.getByRole('button', { name: '查看阿树的名片' }).click();
    await page.getByRole('button', { name: '屏蔽', exact: true }).click();
    await page.getByRole('button', { name: '确认屏蔽' }).click();
    assert.equal(await page.locator('#message-input').count(), 0);
    await page.getByRole('button', { name: '解除屏蔽', exact: true }).click();
    assert.equal(await page.locator('#message-input').count(), 1);
  });
  // Fresh state for accurate, uncluttered screenshots.
  await page.goto(base+'/?scenario=returning#discover');
  await shot('discover-light');
  await check('the fixed community palette stays unchanged when the system switches appearance', async () => {
    const light=await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor);
    const header=await page.locator('.plugin-bar').evaluate(el=>getComputedStyle(el).backgroundColor);
    await page.emulateMedia({colorScheme:'dark'});
    assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),light);
    assert.equal(await page.locator('.plugin-bar').evaluate(el=>getComputedStyle(el).backgroundColor),header);
    await page.emulateMedia({colorScheme:'light'});
  });
  await nav('消息');
  await page.getByRole('button', { name: '与阿树聊天' }).click();
  await shot('messages-light');
  await nav('好友');
  await shot('friends-light');
  await nav('设置');
  await shot('settings-light');
  await nav('发现搭子');
  await page.getByRole('button', { name: '首次使用流程' }).click();
  await shot('onboarding-light');
  await check('native modal traps focus and closes with Escape', async () => {
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('dialog').evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog[open]').count(), 0);
  });
  await check('narrow layouts do not overflow and allow chat return and page scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('discover-mobile');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#main').evaluate(el => el.scrollHeight > el.clientHeight), true);
    await page.locator('#main').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await page.locator('.person-card').count(), 6);
    await nav('消息');
    if(await page.getByRole('button', { name: '返回会话列表' }).isVisible()) await page.getByRole('button', { name: '返回会话列表' }).click();
    await page.getByRole('button', { name: '与阿树聊天' }).click();
    await shot('messages-mobile');
    assert.equal(await page.getByRole('button', { name: '发送', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '返回会话列表' }).click();
    assert.equal(await page.getByRole('button', { name: '与阿树聊天' }).isVisible(), true);
    for (const width of [300, 620, 800, 1100]) {
      await page.setViewportSize({ width, height: 600 });
      for (const name of ['发现搭子','好友','设置','消息']) {
        await nav(name);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} at ${width}px overflows`);
        assert.equal(await page.locator('#main').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `${name} content at ${width}px overflows`);
      }
    }
  });
  await check('no runtime script errors and no outgoing network requests', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(outbound, []);
  });
  await writeFile('.artifacts/design-verification.json', JSON.stringify({ checks, errors, outbound, note:'Offline design only; not a DSH/Nostr integration test.' },null,2));
  console.log(`${checks.length} design checks passed. Screenshots: docs/images/`);
} finally { await browser.close(); }
