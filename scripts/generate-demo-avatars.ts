// Synthetic public identities only. Reuse exactly the native avatar renderer.
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {avatarSvg} from '../src/avatar-pattern.js';
for(const id of [...'abcdefghijkl','self']){
  const publicKey=createHash('sha256').update(`dsh-friends/demo/avatar/v1/${id}`).digest('hex');
  await writeFile(new URL(`../design/avatars/${id}.svg`,import.meta.url),avatarSvg(publicKey));
}
