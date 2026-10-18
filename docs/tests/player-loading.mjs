/* Regression: real readiness, deadlines, retries, cancellation, native HLS and autoplay. */
import assert from 'node:assert/strict';
import { createRoomEnv, wait } from './harness.mjs';

const envs = [];
function make() {
  const env = createRoomEnv({ scripts: ['assets/js/config.js', 'assets/js/util.js', 'assets/js/player.js'] });
  envs.push(env);
  const events = [], ready = [];
  const container = new env.El('div');
  env.body.appendChild(container);
  const player = new env.sandbox.WTPlayer.UnifiedPlayer(container, {
    onReady: event => ready.push(event), onEvent: event => events.push(event),
    onStateChange: event => events.push({ type: 'state', ...event })
  });
  return { ...env, container, player, events, ready, S: env.sandbox.WTPlayer.STATE };
}
const file = name => ({ kind: 'file', src: `https://example.com/${name}.mp4` });
let checks = 0;
try {
  const e = make();
  const pending = e.player.load(file('first'));
  assert.equal(e.player.state, e.S.LOADING);
  assert.equal(e.player.load(file('first')), pending, 'same loading source shares its pending promise');
  assert.notEqual(e.player._video.crossOrigin, 'anonymous', 'plain media playback must not require CORS');
  e.player._video.dispatch('loadedmetadata');
  await pending;
  assert.equal(e.ready.length, 1);
  assert.equal(e.player.isReady(), true);
  checks++;

  const timeout = make();
  await assert.rejects(timeout.player.load(file('slow'), { timeoutMs: 25 }), /مهلة/);
  assert.equal(timeout.player.state, timeout.S.ERROR);
  assert.equal(timeout.ready.length, 0, 'timeout is not fake readiness');
  assert.equal(timeout.container.querySelector('.spinner').hidden, true);
  assert.equal(timeout.container.querySelector('.player__retry').hidden, false);
  const retry = timeout.player.load(file('slow'));
  timeout.player._video.dispatch('loadedmetadata');
  await retry;
  assert.equal(timeout.player.isReady(), true, 'same source is retryable after error');
  assert.equal(timeout.container.querySelectorAll('.player__frame').length, 1, 'no stale wrappers');
  checks++;

  const cancelled = make();
  const old = cancelled.player.load(file('old')).catch(err => err);
  const oldVideo = cancelled.player._video;
  const next = cancelled.player.load(file('new'));
  assert.equal((await old).code, 'load-cancelled');
  oldVideo.dispatch('loadedmetadata');
  oldVideo.dispatch('error');
  oldVideo.dispatch('play');
  assert.equal(cancelled.player.state, cancelled.S.LOADING, 'old callbacks cannot complete/error the new source');
  assert.equal(cancelled.events.length, 0, 'old media state events are ignored');
  cancelled.player._video.dispatch('loadedmetadata');
  await next;
  assert.equal(cancelled.ready.length, 1);
  assert.equal(cancelled.container.querySelectorAll('.player__frame').length, 1);
  checks++;

  /* Listeners must be attached before load(), even if a cached source responds synchronously. */
  const cached = make();
  const create = cached.documentStub.createElement;
  cached.documentStub.createElement = tag => {
    const el = create(tag);
    if (tag === 'video') el.load = () => el.dispatch('loadedmetadata');
    return el;
  };
  await cached.player.load(file('cached'));
  assert.equal(cached.player.isReady(), true);
  checks++;

  const yt = make();
  const firstApi = yt.sandbox.WTPlayer.loadYouTubeApi();
  yt.documentStub.head.children[0].onerror();
  await assert.rejects(firstApi, /يوتيوب/);
  const secondApi = yt.sandbox.WTPlayer.loadYouTubeApi();
  assert.notEqual(firstApi, secondApi, 'YouTube API rejection must not be cached forever');
  yt.sandbox.YT = { Player: function () {} };
  yt.sandbox.onYouTubeIframeAPIReady();
  await secondApi;
  checks++;

  const switching = make();
  const waitingYT = switching.player.load({ kind: 'youtube', id: 'abcdefghijk' }).catch(err => err);
  const loadedFile = switching.player.load(file('after-youtube'));
  let youtubePlayers = 0;
  switching.sandbox.YT = { Player: function () { youtubePlayers++; } };
  switching.sandbox.onYouTubeIframeAPIReady();
  await wait(1);
  assert.equal(youtubePlayers, 0, 'a late API must not mount a cancelled YouTube player');
  assert.equal((await waitingYT).code, 'load-cancelled');
  switching.player._video.dispatch('loadedmetadata');
  await loadedFile;
  checks++;

  const hls = make();
  const callbacks = {};
  hls.sandbox.Hls = class {
    static isSupported() { return true; }
    static Events = { ERROR: 'error' };
    on(name, callback) { callbacks[name] = callback; }
    attachMedia() {}
    loadSource() {}
    destroy() {}
  };
  const loadingHls = hls.player.load({ kind: 'hls', src: 'https://example.com/live.m3u8' });
  assert.equal(hls.player.state, hls.S.LOADING);
  callbacks.error('error', { fatal: true, details: 'manifestLoadError' });
  await assert.rejects(loadingHls, /manifestLoadError/);
  assert.doesNotMatch(hls.container.querySelector('.player__overlay-text').textContent, /لا يدعم/, 'network failure is not an unsupported-browser error');
  checks++;

  const native = make();
  const nativeCreate = native.documentStub.createElement;
  native.documentStub.createElement = tag => {
    const el = nativeCreate(tag);
    if (tag === 'video') el.canPlayType = () => 'probably';
    return el;
  };
  native.sandbox.Hls = class { constructor() { throw new Error('native HLS should not instantiate hls.js'); } };
  const loadingNative = native.player.load({ kind: 'hls', src: 'https://example.com/native.m3u8' });
  assert.equal(native.container.querySelectorAll('video').length, 1);
  native.player._video.dispatch('loadedmetadata');
  await loadingNative;
  assert.equal(native.player.canSync(), true);
  checks++;

  const blocked = make();
  const load = blocked.player.load(file('blocked'));
  blocked.player._video.dispatch('loadedmetadata');
  await load;
  blocked.player._video.play = () => Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
  assert.equal(await blocked.player.play(), false);
  assert.ok(blocked.events.some(event => event.type === 'autoplay-blocked'), 'autoplay failure must reach the room UI');
  checks++;

  console.log(`Player loading: ${checks} regression scenarios passed`);
} finally { envs.forEach(env => env.dispose()); }
