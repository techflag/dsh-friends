import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { initialStored, storedSchema, FriendsError } from './model.js';
import { FriendsService } from './service.js';

export const name='dsh-friends';
export const inject=['storageDomain','connection','webServer'];
export async function apply(ctx:Context){
  const domain=await ctx.storageDomain.open(defineDomain({name:'dsh_friends',version:1,global:{schema:storedSchema,initial:initialStored()},tables:{}}));
  const service=new FriendsService({read:()=>domain.global.get(),write:value=>domain.global.set(value)});
  ctx.effect(()=>async()=>{try{await service.close();}finally{await domain.close();}},'dsh-friends.host');
  // Exact Fetch routes inherit official Connection's owner-Peer admission.
  // Keep a private route instead of claiming the shared /api interceptor.
  const unregister=ctx.connection.fetch.register({path:'/api/dsh-friends',methods:['POST'],requestBody:'buffered',fetch:async request=>{
    const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
    try {
      const text=await request.text();
      if(text.length>16_000)return response({ok:false,error:{code:'too-large',message:'请求内容过长。'}},413);
      const body:unknown=JSON.parse(text);
      if(!body||typeof body!=='object'||!('endpoint' in body)||typeof body.endpoint!=='string'||body.endpoint.length>64)return response({ok:false,error:{code:'invalid-request',message:'请求格式无效。'}},400);
      const payload='payload' in body?body.payload:{};
      return response({ok:true,value:await service.command(body.endpoint,payload)});
    }catch(error){return response({ok:false,error:{code:error instanceof FriendsError?error.code:'invalid-operation',message:error instanceof FriendsError?error.message:'操作未完成：请核对输入或本地存储；原数据未主动清空。'}},400);}
  }});
  ctx.effect(()=>unregister,'dsh-friends.rpc');
  void service.start().catch(()=>{});
}
