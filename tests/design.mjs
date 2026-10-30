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
  await page.getByRole('link', { name, exact: true }).click();
  await page.getByRole('heading', { name: ({ '发现搭子':'发现搭子', '好友':'我的好友', '设置':'连接与隐私', '消息':'消息' })[name], exact:true }).waitFor();
}
async function shot(name) {
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await page.screenshot({ path: `docs/images/${name}.png`, fullPage: false });
}
try {
  await mkdir('docs/images', { recursive: true });
  await mkdir('.artifacts', { recursive: true });
  await page.goto(base);
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
    await page.locator('[data-person="b"]').getByRole('button', { name: '加为好友' }).click();
    await page.getByLabel('打个招呼').fill('想交流一下产品设计。');
    await page.getByRole('button', { name: '发送邀请（演示）' }).click();
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
  await page.goto(base);
  await shot('discover-light');
  await check('dark and system themes update the whole surface', async () => {
    await page.getByLabel('预览主题').selectOption('dark');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await shot('discover-dark');
    await page.getByLabel('预览主题').selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
    await page.emulateMedia({ colorScheme: 'light' });
    assert.notEqual(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), dark);
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
