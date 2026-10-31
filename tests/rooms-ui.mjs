// Isolated React component checks; no DSH host or public-network claim.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {resolve} from 'node:path';
const bundle=await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {Lobby} from './src/lobby';import {styles} from './src/client-style';
const entries=Array.from({length:30},(_,i)=>({id:'g'+i,room:'general',publicKey:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'测试搭子',text:'大厅消息 '+i,createdAt:100+i}));
function App(){const [room,setRoom]=React.useState('general'),[posts,setPosts]=React.useState([...entries,{id:'b1',room:'builders',publicKey:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'乙',text:'插件房间专属',createdAt:110}]);const [done,setDone]=React.useState(false);
window.renameTestUser=()=>setPosts(current=>current.map(post=>({...post,name:'改过的昵称'})));
const snapshot={relays:[{state:'connected'}],identity:'ready',publicKey:'self',lobby:posts,roomOnline:{general:2,builders:1,random:0},roomEntries:[],roomHistory:{general:{loaded:true,exhausted:done},builders:{loaded:true,exhausted:true},random:{loaded:true,exhausted:true}}};
return <div className="dsh-friends" style={{height:500}}><style>{styles}</style><Lobby key={room} room={room} snapshot={snapshot} busy={false} draft="" setDraft={()=>{}} setReply={()=>{}} onRoom={setRoom} onConnect={()=>{}} onIdentity={()=>{}} onPerson={()=>{}} onSend={async()=>{}} onRetry={()=>{}} onHistory={async()=>{await new Promise(r=>setTimeout(r,100));setPosts(current=>[...Array.from({length:10},(_,i)=>({id:'old'+i,room:'general',publicKey:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'历史',text:'更早记录 '+i,createdAt:i})),...current]);setDone(true);}}/></div>}
createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',plugins:[{name:'primitive-test-adapter',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:"import React from 'react'; export function Button({variant,size,...props}){return <button {...props}/>}",loader:'jsx',resolveDir:process.cwd()}));}}]});
const browser=await chromium.launch({headless:true});
try{const page=await browser.newPage({viewport:{width:1200,height:650}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});await page.locator('[data-post-id="g29"]').waitFor();
const originalAvatar=await page.locator('[data-post-id="g29"] img').getAttribute('src');
await page.evaluate(()=>window.renameTestUser());await page.waitForFunction(()=>document.querySelector('[data-post-id="g29"] .df-person-name')?.textContent==='改过的昵称');
assert.equal(await page.locator('[data-post-id="g29"] img').getAttribute('src'),originalAvatar,'renaming must not change the identity avatar');
assert.equal(await page.getByText('插件房间专属',{exact:true}).count(),0);
await page.getByRole('button',{name:/# 插件交流/}).click();await page.getByText('插件房间专属',{exact:true}).waitFor();assert.equal(await page.locator('[data-post-id="g29"]').count(),0);
await page.getByRole('button',{name:/# 大厅/}).click();
await page.locator('.df-lobby-history').evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
const before=await page.locator('[data-post-id="g0"]').evaluate(el=>el.getBoundingClientRect().top);
await page.locator('[data-post-id="old0"]').waitFor();
const after=await page.locator('[data-post-id="g0"]').evaluate(el=>el.getBoundingClientRect().top);
assert(Math.abs(before-after)<4,`prepending history moved the visible anchor: ${before} -> ${after}`);
assert.equal(await page.locator('textarea:visible').count(),1);
await page.setViewportSize({width:390,height:650});
assert(await page.locator('.df-room-shell').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
assert.deepEqual(errors,[]);console.log('PASS stable avatars after renaming, room isolation, upward history loading, preserved scroll anchor, one composer and narrow layout');
}finally{await browser.close();}
