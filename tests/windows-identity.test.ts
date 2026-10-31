import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {windowsLocalIdentityStore} from '../src/windows-identity.js';

test('Windows identity adapter verifies persistence and only treats missing records as absent',async()=>{
  const id=randomUUID(),secret=randomBytes(48).toString('hex');
  const values=new Map<string,string>();
  const store=windowsLocalIdentityStore(async request=>{
    if(request.operation==='write'){values.set(request.id,request.value!);return {code:0,output:''};}
    if(request.operation==='remove'){values.delete(request.id);return {code:0,output:''};}
    return values.has(request.id)?{code:0,output:values.get(request.id)!}:{code:44,output:''};
  });
  assert.equal(await store.read(id),undefined);
  await store.write(id,secret);assert.equal(await store.read(id),secret);
  await store.remove(id);assert.equal(await store.read(id),undefined);
  const unavailable=windowsLocalIdentityStore(async()=>({code:1,output:secret}));
  await assert.rejects(unavailable.read(id),error=>error instanceof Error&&error.message==='protected store unavailable');
});

test('Windows identity rejects malformed inputs and failed read-back without exposing secrets',async()=>{
  let calls=0;
  const store=windowsLocalIdentityStore(async()=>{calls++;return {code:0,output:''};});
  await assert.rejects(store.read('../other-file'));
  await assert.rejects(store.write(randomUUID(),'not-a-secret'));
  assert.equal(calls,0);
  await assert.rejects(store.write(randomUUID(),randomBytes(48).toString('hex')),/protected store/);
});

test('Windows CurrentUser DPAPI survives a new adapter and never stores plaintext', {skip:process.platform!=='win32'}, async()=>{
  const {readFile}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const id=randomUUID(),secret=randomBytes(48).toString('hex'),store=windowsLocalIdentityStore();
  try{
    assert.equal(await store.read(id),undefined);
    await store.write(id,secret);
    assert.equal(await windowsLocalIdentityStore().read(id),secret);
    const bytes=await readFile(join(process.env.LOCALAPPDATA!,'DSHFriends','ProtectedIdentity',id+'.dpapi'));
    assert.equal(bytes.includes(Buffer.from(secret)),false);
  }finally{await store.remove(id);}
});
