import assert from 'node:assert/strict';
import test from 'node:test';
import {UnreadNotifications} from '../src/notifications.js';

test('unread counts group rooms and private conversations, ignore entries, deduplicate and clear independently',()=>{
  const unread=new UnreadNotifications();let changes=0;const stop=unread.subscribe(()=>changes++);
  unread.sync([
    {id:'room-1',room:'general',createdAt:1},
    {id:'room-1',room:'general',createdAt:1},
    {id:'room-2',room:'builders',createdAt:2},
    {id:'private-1',peer:'a'.repeat(64),createdAt:3},
    {id:'entry-1',room:'general',createdAt:4,kind:'entry'},
  ]);
  assert.deepEqual(unread.getSnapshot(),{total:3,publicTotal:2,privateTotal:1,rooms:{general:1,builders:1,random:0},peers:{['a'.repeat(64)]:1}});
  unread.clear({room:'general'});assert.equal(unread.getSnapshot().total,2);assert.equal(unread.getSnapshot().rooms.general,0);
  unread.clear({peer:'a'.repeat(64)});assert.equal(unread.getSnapshot().total,1);assert.equal(unread.getSnapshot().privateTotal,0);
  assert.equal(changes,3);stop();
});
