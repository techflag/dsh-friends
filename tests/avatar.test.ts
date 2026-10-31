import {test} from 'node:test';
import assert from 'node:assert/strict';
import {avatarSvg} from '../src/avatar-pattern.js';

test('avatar identity is stable across reloads and key case, and uses the full public key',()=>{
  const identity='1234567890abcdef'.repeat(4);
  assert.equal(avatarSvg(identity),avatarSvg(identity.toUpperCase()));
  assert.equal(avatarSvg(identity),avatarSvg(String(identity)));
  assert.notEqual(avatarSvg(identity),avatarSvg(identity.slice(0,-1)+'e'),'same prefix alone must not determine the avatar');
});
test('absent and untrusted identities get a neutral local avatar without reflecting input',()=>{
  const neutral=avatarSvg();
  assert.equal(avatarSvg('<svg onload="alert(1)">'),neutral);
  assert.equal(avatarSvg('https://untrusted.test/face.png'),neutral);
  const svg=avatarSvg('a'.repeat(64));
  assert(!svg.includes('a'.repeat(64)));
  assert(!/foreignObject|<image|<script|onload|href=/.test(svg));
});
