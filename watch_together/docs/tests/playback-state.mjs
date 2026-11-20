/* Regression: delayed room-state acknowledgements must never undo newer playback. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRoomEnv, wait } from './harness.mjs';

const videoUrl = 'https://media.example/watch.mp4';
const ownerToken = 'a'.repeat(64);
const env = createRoomEnv({
  search: '?id=PLAYST1&host=1',
  store: { 'wt:owner:PLAYST1': JSON.stringify(ownerToken) }
});
const check = (condition, message) => assert.ok(condition, message);

try {
  env.sandbox.WT_CONFIG.javaServer.enabled = false;
  env.sandbox.WT_CONFIG.supabase.ready = false;
  await wait(300);
  const room = env.sandbox.WTRoom;
  check(room.session.ready && room.session.transport, 'test room joined before playback state is simulated');
  check(room.setVideo(videoUrl), 'supported video loads');
  await wait(20);
  room.player._video.dispatch('loadedmetadata');
  await wait(20);
  check(room.player.isReady(), 'test player reached its real ready state');

  const state = (rev, playing, updatedBy, pos) => ({
    url: videoUrl, kind: 'file', rev, playing, pos, t: Date.now(), updatedBy,
    updatedByName: updatedBy
  });
  room.onRemoteState(state(100, true, 'active-tab', 15));
  await wait(270);
  check(room.state.playing && room.player.isPlaying(), 'newer shared play state starts playback');

  const transport = room.session.transport;
  const writes = [];
  transport.publishState = snapshot => new Promise(resolve => writes.push({ snapshot: { ...snapshot }, resolve }));
  env.byId.get('centerPlayBtn').dispatch('click', {});
  await wait(70);
  check(writes.length === 1 && writes[0].snapshot.playing === false,
    'the simulated delayed write contains the earlier pause snapshot');

  room.onRemoteState(state(102, true, 'newer-tab', 25));
  check(room.state.playing && room.player.isPlaying(), 'a newer remote resume is applied while the old write is pending');
  writes[0].resolve(state(writes[0].snapshot.rev, false, writes[0].snapshot.updatedBy, 15));
  await wait(30);
  check(room.state.rev === 102 && room.state.playing && room.player.isPlaying(),
    'late response cannot roll the room or player back to paused');

  const roomStore = fs.readFileSync(new URL('../../java-server/src/com/watchtogether/RoomStore.java', import.meta.url), 'utf8');
  check(roomStore.includes('clientRev < currentRev') && roomStore.includes('stored.remove("authoritative")'),
    'the WebSocket server rejects stale revisions and strips client-forged authority flags');
  console.log('Playback state: 5 checks passed (late pause acknowledgements, remote resume, and server stale-write guards)');
} finally {
  env.dispose();
}
