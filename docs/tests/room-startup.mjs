/* Regression: room controls must work before authentication/network/media finish. */
import assert from 'node:assert/strict';
import { createRoomEnv, wait } from './harness.mjs';

const envs = [];
const make = (options = {}) => {
  const env = createRoomEnv({ search: '?id=START1&local=1', ...options });
  envs.push(env);
  assert.deepEqual(env.loaded.filter(s => !s.ok), [], 'all room scripts load');
  return env;
};
const enter = env => {
  env.byId.get('gateName').value = 'فاحص الغرفة';
  env.byId.get('gateForm').dispatch('submit');
};
const click = (env, id) => env.byId.get(id).dispatch('click');
const account = {
  access_token: 'expired-test-token', refresh_token: 'test-refresh', expires_at: 1,
  user: { id: 'account-1', name: 'حساب تجريبي', email: 'test@example.com' }
};
let checks = 0;
try {
  /* No request should delay attaching handlers, including a removed optional control. */
  const pending = make({ omitIds: ['videoFullscreenBtn'] });
  let finishAuth;
  pending.sandbox.WTAuth.validSession = () => new Promise(resolve => { finishAuth = resolve; });
  enter(pending);
  assert.equal(pending.sandbox.WTRoom.session.ready, false);
  for (const id of ['addVideoBtn', 'messagesBtn', 'playlistBtn', 'drawerOpenBtn', 'qrBtn', 'diagBtn', 'chatForm']) {
    assert.ok(Object.values(pending.byId.get(id)._handlers).some(list => list.length), `${id} wired before auth`);
  }
  click(pending, 'drawerOpenBtn');
  assert.equal(pending.byId.get('drawerScrim').hidden, false);
  click(pending, 'drawerCloseBtn');
  click(pending, 'addVideoBtn');
  assert.equal(pending.byId.get('changeBar').hidden, false);
  click(pending, 'cancelUrlBtn');
  click(pending, 'playlistBtn');
  assert.equal(pending.byId.get('playlistModal').hidden, false);
  click(pending, 'playlistCloseBtn');
  click(pending, 'messagesBtn');
  click(pending, 'messagesBtn');
  await wait(110);
  assert.equal(pending.byId.get('chatInput')._focused, undefined, 'cancelled focus mode must not steal focus');
  finishAuth({ ...account });
  await wait(30);
  assert.equal(pending.sandbox.WTRoom.session.userId, 'account-1', 'use session.user, not session.id');
  assert.equal(pending.sandbox.WTRoom.session.isGuest, false);
  checks++;

  /* Fetch can hang before headers OR while reading JSON. Both have a deadline. */
  for (const fetch of [
    () => new Promise(() => {}),
    async () => ({ ok: true, json: () => new Promise(() => {}) })
  ]) {
    const env = make({ store: { 'wt:session': JSON.stringify(account) }, fetch });
    env.sandbox.WT_CONFIG.auth.timeoutMs = 30;
    enter(env);
    click(env, 'qrBtn');
    assert.equal(env.byId.get('qrModal').hidden, false);
    await wait(80);
    assert.equal(env.sandbox.WTRoom.session.ready, true, 'network timeout must not strand entry');
    assert.equal(env.sandbox.WTRoom.session.userId, account.user.id);
    assert.ok(env.sandbox.WTAuth.getSession(), 'transient failure must not sign the user out');
    checks++;
  }

  /* A video that never sends metadata must not hold up chat, presence or timers. */
  const slowVideo = make({
    search: '?id=START1&local=1&v=https%3A%2F%2Fexample.com%2Fslow.mp4',
    store: { 'wt:owner:START1': JSON.stringify('a'.repeat(64)) }
  });
  enter(slowVideo);
  await wait(30);
  const room = slowVideo.sandbox.WTRoom;
  assert.equal(room.player.state, slowVideo.sandbox.WTPlayer.STATE.LOADING);
  assert.equal(room.session.ready, true);
  assert.ok(room.session._pingTimer && room.session._uiTimer, 'loops start without waiting for media');
  slowVideo.byId.get('chatInput').value = 'الرسائل تعمل أثناء التحميل';
  slowVideo.byId.get('chatForm').dispatch('submit');
  assert.equal(slowVideo.byId.get('chatInput').value, '');
  assert.ok(slowVideo.byId.get('chatBody').children.some(row => row.dataset.text === 'الرسائل تعمل أثناء التحميل'));
  checks++;

  /* Unblocking autoplay is local even for a viewer; pausing/changing video removes stale prompts. */
  const video = room.player._video;
  video.duration = 120;
  video.dispatch('loadedmetadata');
  await wait(5);
  room.state.playing = true;
  room.session.role = 'viewer';
  video.play = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  await room.player.play();
  assert.equal(room.session.autoplayBlocked, true);
  let publishes = 0;
  room.session.transport.publishState = () => { publishes++; };
  video.play = () => Promise.resolve();
  room.session.autoplayPrompt.querySelector('#unblockPlay').dispatch('click');
  assert.equal(room.session.autoplayBlocked, false);
  assert.equal(publishes, 0, 'unblock must not broadcast play or change roles');
  room.player.opts.onEvent({ type: 'autoplay-blocked' });
  assert.ok(room.session.autoplayPrompt);
  room.onRemoteState({ ...room.state, playing: false, authoritative: true, rev: 20, updatedBy: 'host' });
  assert.equal(room.session.autoplayPrompt, null);
  checks++;

  /* Signed-in accounts enter any invitation/card without ?auto=1 or a gate submit. */
  const signedIn = make({ store: { 'wt:session': JSON.stringify({ ...account, expires_at: Date.now() + 3600000 }) } });
  assert.equal(signedIn.byId.get('gate').hidden, true);
  await wait(35);
  assert.equal(signedIn.sandbox.WTRoom.session.ready, true);
  assert.equal(signedIn.sandbox.WTRoom.session.name, account.user.name);
  assert.equal(signedIn.sandbox.WTRoom.session.isGuest, false);
  checks++;

  /* A saved guest and old creator/auto hints cannot bypass name confirmation. */
  const guest = make({
    search: '?id=START1&local=1&auto=1',
    store: { 'wt:session': JSON.stringify({ user: { id: 'guest-test', name: 'اسم محفوظ', guest: true } }) },
    session: { 'wt:create:START1': JSON.stringify({ name: 'اسم المنشئ القديم', host: true, ownerToken: 'a'.repeat(64) }) }
  });
  await wait(35);
  assert.equal(guest.byId.get('gate').hidden, false);
  assert.equal(guest.sandbox.WTRoom.session.ready, false);
  enter(guest);
  await wait(35);
  assert.equal(guest.sandbox.WTRoom.session.ready, true);
  assert.equal(guest.sandbox.WTRoom.session.userId, null, 'guest IDs must not be written into a UUID user_id column');
  assert.equal(guest.sandbox.WTRoom.session.isGuest, true);
  checks++;

  /* An invalidated account returns to the name gate instead of entering under stale identity. */
  const invalid = make({
    store: { 'wt:session': JSON.stringify(account) },
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ message: 'Invalid refresh token' }) })
  });
  await wait(40);
  assert.equal(invalid.sandbox.WTRoom.session.ready, false);
  assert.equal(invalid.byId.get('gate').hidden, false);
  assert.equal(invalid.byId.get('room').hidden, true);
  enter(invalid);
  await wait(35);
  assert.equal(invalid.sandbox.WTRoom.session.ready, true);
  assert.equal(invalid.sandbox.WTRoom.session.isGuest, true);
  checks++;

  /* A live card counts joined tabs, not historical roles; a tab switch is not leaving. */
  const attendance = make();
  enter(attendance);
  await wait(35);
  const attendee = attendance.sandbox.WTRoom.session;
  const lease = 'local:presence:START1:' + attendee.clientId;
  assert.equal(attendance.sandbox.WTUtil.store.get(lease).name, attendee.name);
  attendance.sandbox.document.hidden = true;
  attendance.sandbox.document.dispatch('visibilitychange');
  assert.ok(attendance.sandbox.WTUtil.store.get(lease), 'switching to the lobby must not delete an open room connection');
  attendance.sandbox.document.hidden = false;
  attendance.sandbox.document.dispatch('visibilitychange');
  assert.ok(attendance.sandbox.WTUtil.store.get(lease).lastSeen);
  attendee.transport.close();
  assert.equal(attendance.sandbox.WTUtil.store.get(lease), undefined, 'closing the connection removes its lease immediately');
  checks++;

  console.log(`Room startup: ${checks} regression scenarios passed`);
} finally { envs.forEach(env => env.dispose()); }
