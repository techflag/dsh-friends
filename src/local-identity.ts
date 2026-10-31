import {execFile} from 'node:child_process';
import {windowsLocalIdentityStore} from './windows-identity.js';
export interface LocalIdentityStore {read(id:string):Promise<string|undefined>;write(id:string,value:string):Promise<void>;remove(id:string):Promise<void>;}
const service='dsh-friends.local-identity.v1';
const validId=(id:string)=>/^[0-9a-f-]{36}$/.test(id);
function security(args:string[],input?:string):Promise<{code:number;output:string}>{
  return new Promise(resolve=>{
    // Secrets go through stdin and captured stdout, never argv, logs or Client RPC.
    const child=execFile('/usr/bin/security',args,{timeout:15000,maxBuffer:16384},(error,stdout)=>resolve({code:error?Number(error.code)||1:0,output:stdout.trim()}));
    child.stdin?.end(input);
  });
}
export function localIdentityStore():LocalIdentityStore|undefined {
  if(process.platform==='win32')return windowsLocalIdentityStore();
  if(process.platform!=='darwin')return undefined;
  return {
    async read(id){if(!validId(id))throw Error('invalid local identity');const r=await security(['find-generic-password','-s',service,'-a',id,'-w']);if(r.code===44)return undefined;if(r.code||!/^([0-9a-f]{96})$/.test(r.output))throw Error('protected store unavailable');return r.output;},
    async write(id,value){if(!validId(id)||!/^([0-9a-f]{96})$/.test(value))throw Error('invalid local identity');const result=await security(['-i'],`add-generic-password -U -s ${service} -a ${id} -w ${value}\n`);if(result.code)throw Error('protected store unavailable');const saved=await this.read(id);if(saved!==value)throw Error('protected store write failed');},
    async remove(id){if(validId(id))await security(['delete-generic-password','-s',service,'-a',id]);},
  };
}
