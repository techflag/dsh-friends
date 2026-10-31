import {execFile} from 'node:child_process';
import {win32} from 'node:path';
import type {LocalIdentityStore} from './local-identity.js';

// Only this fixed program enters argv. Identity IDs and secrets travel over stdin.
// CurrentUser DPAPI binds the encrypted file to the Windows user's credentials.
const program=String.raw`
$ErrorActionPreference = 'Stop'
$plain = $null
$temporary = $null
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'invalid id' }
  $root = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($root)) { throw 'missing user directory' }
  $directory = [IO.Path]::Combine($root, 'DSHFriends', 'ProtectedIdentity')
  $file = [IO.Path]::Combine($directory, $request.id + '.dpapi')
  $entropy = [Text.Encoding]::UTF8.GetBytes('dsh-friends.local-identity.v1')
  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
  switch ($request.operation) {
    'read' {
      if (-not [IO.File]::Exists($file)) { exit 44 }
      if (([IO.FileInfo]$file).Length -gt 16384) { throw 'invalid protected record' }
      $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file), $entropy, $scope)
      $value = [Text.Encoding]::UTF8.GetString($plain)
      if ($value -cnotmatch '^[0-9a-f]{96}$') { throw 'invalid protected value' }
      [Console]::Out.Write($value)
    }
    'write' {
      if ($request.value -cnotmatch '^[0-9a-f]{96}$') { throw 'invalid value' }
      $plain = [Text.Encoding]::UTF8.GetBytes($request.value)
      $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, $scope)
      [void][IO.Directory]::CreateDirectory($directory)
      $temporary = [IO.Path]::Combine($directory, [Guid]::NewGuid().ToString() + '.tmp')
      [IO.File]::WriteAllBytes($temporary, $encrypted)
      if ([IO.File]::Exists($file)) { [IO.File]::Replace($temporary, $file, $null) }
      else { [IO.File]::Move($temporary, $file) }
    }
    'remove' { [IO.File]::Delete($file) }
    default { throw 'invalid operation' }
  }
} catch {
  # Do not emit exceptions or input: they may contain sensitive values.
  exit 1
} finally {
  if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
  if ($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
`;
type Request={operation:'read'|'write'|'remove';id:string;value?:string};
type Runner=(request:Request)=>Promise<{code:number;output:string}>;
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const valuePattern=/^[0-9a-f]{96}$/;

const run:Runner=request=>new Promise(resolve=>{
  const executable=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=execFile(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(program,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:16384},(error,stdout)=>{
    resolve({code:error?Number(error.code)||1:0,output:stdout.trim()});
  });
  child.stdin?.on('error',()=>{});
  child.stdin?.end(JSON.stringify(request));
});

export function windowsLocalIdentityStore(execute:Runner=run):LocalIdentityStore {
  const validate=(id:string)=>{if(!idPattern.test(id))throw Error('invalid local identity');};
  return {
    async read(id){validate(id);const result=await execute({operation:'read',id});if(result.code===44)return undefined;if(result.code||!valuePattern.test(result.output))throw Error('protected store unavailable');return result.output;},
    async write(id,value){validate(id);if(!valuePattern.test(value))throw Error('invalid local identity');const result=await execute({operation:'write',id,value});if(result.code)throw Error('protected store unavailable');if(await this.read(id)!==value)throw Error('protected store write failed');},
    async remove(id){validate(id);const result=await execute({operation:'remove',id});if(result.code)throw Error('protected store unavailable');},
  };
}
