/* Real player zoom: scale the media surface itself, pan it, and keep it local to this viewer. */
import assert from 'node:assert/strict';
import { createRoomEnv, wait } from './harness.mjs';

const videoUrl = 'https://media.example/watch.mp4';
const ownerToken = 'z'.repeat(64);
const env = createRoomEnv({
  search: '?id=ZOOM01&host=1',
  store: { 'wt:owner:ZOOM01': JSON.stringify(ownerToken) }
});
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

try {
  env.sandbox.WT_CONFIG.javaServer.enabled = false;
  env.sandbox.WT_CONFIG.supabase.ready = false;
  await wait(300);
  const room = env.sandbox.WTRoom;
  check(room.session.ready && room.session.transport, 'the room joins before testing the player');
  check(room.setVideo(videoUrl), 'the MP4 player loads');
  await wait(30);
  room.player._video.dispatch('loadedmetadata');
  await wait(30);

  const frame = () => room.el.player.querySelector('.player__frame');
  const zoomIn = env.byId.get('videoZoomIn');
  const zoomOut = env.byId.get('videoZoomOut');
  const zoomReset = env.byId.get('videoZoomLevel');
  check(room.player.isReady() && frame(), 'media frame is ready for visual zoom');
  check(!zoomIn.disabled && zoomOut.disabled, 'zoom controls reflect the initial 100% level');

  const before = { rev: room.state.rev, playing: room.state.playing, url: room.state.url };
  const transport = room.session.transport;
  let zoomPublishes = 0;
  const originalPublishState = transport.publishState;
  transport.publishState = () => { zoomPublishes++; return true; };
  zoomIn.click();
  check(frame().style.transform.includes('scale(1.25)'), 'zoom-in scales the actual video frame to 125%');
  check(zoomReset.textContent === '125%' && !zoomOut.disabled, 'zoom level and zoom-out control update');
  zoomIn.click();
  check(frame().style.transform.includes('scale(1.5)'), 'each zoom step increases the rendered scale');

  room.el.player.dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 50, clientY: 10 });
  room.el.player.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 90, clientY: 10 });
  check(frame().style.transform.includes('translate3d(25px, 0px, 0) scale(1.5)'),
    'drag pans the enlarged video while clamping movement to the player bounds');
  room.el.player.dispatch('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 90, clientY: 10 });

  zoomReset.click();
  check(frame().style.transform === '' && zoomReset.textContent === '100%', 'reset restores the original full-frame view');
  room.el.player.dispatch('wheel', { ctrlKey: true, metaKey: false, deltaY: -100, clientX: 30, clientY: 10 });
  check(frame().style.transform.includes('translate3d(5px, 0.25px, 0) scale(1.25)'),
    'Ctrl/trackpad wheel zooms toward the pointer rather than merely enlarging from center');

  zoomReset.click();
  room.el.player.dispatch('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 30, clientY: 10 });
  room.el.player.dispatch('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 70, clientY: 10 });
  room.el.player.dispatch('pointermove', { pointerId: 3, pointerType: 'touch', clientX: 90, clientY: 10 });
  check(frame().style.transform.includes('scale(1.5)'), 'two-finger pinch zooms the media itself');
  room.el.player.dispatch('pointerup', { pointerId: 3, pointerType: 'touch', clientX: 90, clientY: 10 });
  room.el.player.dispatch('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 30, clientY: 10 });
  zoomIn.click();
  check(zoomReset.textContent === '175%', 'pinch zoom composes correctly with button zoom');
  while (!zoomIn.disabled) zoomIn.click();
  check(zoomReset.textContent === '300%' && zoomIn.disabled, 'zoom has a safe maximum of 300%');
  while (!zoomOut.disabled) zoomOut.click();
  check(zoomReset.textContent === '100%' && zoomOut.disabled, 'zoom-out clamps at the original 100% size');

  check(room.state.rev === before.rev && room.state.playing === before.playing && room.state.url === before.url && zoomPublishes === 0,
    'view-only zoom never changes or publishes synchronized room playback state');
  transport.publishState = originalPublishState;

  const htmlFrame = frame();
  htmlFrame.remove();
  const bareYoutubeFrame = env.sandbox.document.createElement('iframe');
  room.el.player.appendChild(bareYoutubeFrame);
  zoomIn.click();
  check(bareYoutubeFrame.style.transform.includes('scale(1.25)'),
    'zoom also works when YouTube replaces its placeholder with a bare iframe');
  zoomReset.click();
  bareYoutubeFrame.remove();
  room.el.player.appendChild(htmlFrame);

  check(room.setVideo('https://media.example/next.mp4'), 'changing the source remains supported');
  await wait(20);
  room.player._video.dispatch('loadedmetadata');
  await wait(20);
  check(frame().style.transform === '' && zoomReset.textContent === '100%', 'a new video starts at normal scale');

  console.log(`Player zoom: ${checks} checks passed (true scale, pan, wheel, pinch, bounds, reset, local-only state, source reset)`);
} finally {
  env.dispose();
}
