import {execFile} from 'node:child_process';
import {win32} from 'node:path';
import {getProxyForUrl} from 'proxy-from-env';

export interface SystemProxy {enabled:boolean;server:string;bypass:string;pac:string;}
export interface ProxyPolicy {label:string;proxyForUrl:(url:string)=>string;}
const script=String.raw`
$ErrorActionPreference='Stop'
try {
  $p=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  [Console]::Out.Write((@{enabled=($p.ProxyEnable -eq 1);server=[string]$p.ProxyServer;bypass=[string]$p.ProxyOverride;pac=[string]$p.AutoConfigURL} | ConvertTo-Json -Compress))
} catch { exit 1 }
`;
async function readWindowsProxy():Promise<SystemProxy>{
  return new Promise((resolve,reject)=>{
    const executable=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    execFile(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:8000,maxBuffer:16384},(error,stdout)=>{
      if(error){reject(Error('无法读取 Windows 系统代理，请确认系统自带 PowerShell 可用。'));return;}
      try{const p=JSON.parse(stdout);if(typeof p.enabled!=='boolean'||![p.server,p.bypass,p.pac].every(v=>typeof v==='string'))throw Error();resolve(p);}catch{reject(Error('Windows 系统代理设置无法识别。'));}
    });
  });
}

function bypasses(target:URL,list:string){
  const hostname=target.hostname.toLowerCase();
  return list.split(';').map(v=>v.trim().toLowerCase()).filter(Boolean).some(pattern=>{
    if(pattern==='<local>')return !hostname.includes('.')||hostname==='localhost'||hostname==='127.0.0.1'||hostname==='[::1]';
    const escaped=pattern.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*');
    return new RegExp('^'+escaped+'$').test(hostname)||new RegExp('^'+escaped+'$').test(target.host.toLowerCase());
  });
}
export function systemProxyForUrl(settings:SystemProxy,url:string):string {
  if(!settings.enabled){if(settings.pac)throw Error('系统使用自动代理脚本（PAC），本版尚不支持；请在代理软件中启用手动系统代理。');return '';}
  const target=new URL(url);if(bypasses(target,settings.bypass))return '';
  const secure=target.protocol==='wss:'||target.protocol==='https:';
  const entries=settings.server.split(';').map(v=>v.trim()).filter(Boolean);
  const pairs=new Map(entries.filter(v=>v.includes('=')).map(v=>{const i=v.indexOf('=');return [v.slice(0,i).toLowerCase(),v.slice(i+1)] as const;}));
  const address=pairs.size?(pairs.get(secure?'https':'http')??pairs.get('http')??pairs.get('socks')):entries[0];
  if(!address)throw Error('系统代理已开启，但未找到可用代理地址。');
  const socks=pairs.get('socks')===address&&!pairs.get(secure?'https':'http')&&!pairs.get('http');
  const proxy=new URL(address.includes('://')?address:(socks?'socks5h://':'http://')+address);
  if(!['http:','https:','socks:','socks4:','socks4a:','socks5:','socks5h:'].includes(proxy.protocol)||!proxy.hostname||proxy.pathname!=='/'&&proxy.pathname!=='')throw Error('系统代理地址格式暂不支持。');
  return proxy.href;
}

export async function hostProxyPolicy(platform:NodeJS.Platform=process.platform,read:()=>Promise<SystemProxy>=readWindowsProxy):Promise<ProxyPolicy>{
  const environment=Object.keys(process.env).some(k=>/^(https?|all|wss?|npm_config_(https?|all|wss?))_proxy$/i.test(k)&&process.env[k]);
  if(environment)return {label:'环境代理（含绕过规则）',proxyForUrl:url=>getProxyForUrl(url)||getProxyForUrl(url.replace(/^wss:/,'https:').replace(/^ws:/,'http:'))};
  if(platform==='win32'){
    const settings=await read();
    return {label:settings.enabled?'Windows 系统代理':settings.pac?'Windows 自动代理':'直接连接',proxyForUrl:url=>systemProxyForUrl(settings,url)};
  }
  return {label:'直接连接',proxyForUrl:()=>''};
}

export function connectionFailure(error:unknown,proxied:boolean):string {
  const code=(error as {code?:string;cause?:{code?:string}})?.code??(error as {cause?:{code?:string}})?.cause?.code;
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')return '域名解析失败，请检查网络或代理的 DNS 设置。';
  if(code==='ECONNREFUSED')return proxied?'代理端口拒绝连接，请确认代理软件正在运行。':'节点拒绝连接，请稍后重试。';
  if(code==='ETIMEDOUT'||/timed? ?out|timeout/i.test(String(error)))return proxied?'通过代理连接超时，请检查代理是否能访问公共中继。':'直连超时，请检查网络是否可访问公共中继。';
  if(code&&/CERT|VERIFY|SELF_SIGNED/.test(code))return 'TLS 证书校验失败，请检查系统时间或代理证书；未关闭安全校验。';
  if(/407/.test(String(error)))return '代理要求身份验证，当前连接未获授权。';
  return proxied?'代理连接或 WebSocket 握手失败，请检查代理与网络策略。':'WebSocket 连接失败，请检查网络；Windows 系统代理会自动读取。';
}
