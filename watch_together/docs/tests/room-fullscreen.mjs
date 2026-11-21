/* Native player fullscreen regression coverage (browser chrome hidden when supported). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRoomEnv, wait, setAccountName } from './harness.mjs';

const ownerToken = 'f'.repeat(64);
const env = createRoomEnv({
  search: '?id=FULLSC1&host=1',
  store: { 'wt:owner:FULLSC1': JSON.stringify(ownerToken) }
});
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

try {
  env.sandbox.WT_CONFIG.javaServer.enabled = false;
  env.sandbox.WT_CONFIG.supabase.ready = false;
  setAccountName(env, 'مشاهد');
  await wait(350);

  const { byId, documentStub } = env;
  const stage = byId.get('stage');
  const button = byId.get('videoFullscreenBtn');
  const roomJs = env.loaded.find(item => item.file.endsWith('/room.js'));
  const roomSource = fs.readFileSync(new URL('../../assets/js/room.js', import.meta.url), 'utf8');
  check(!!roomJs && roomJs.ok, 'room script loads');
  check(!/videoZoom|video-zoom|PLAYER_ZOOM|playerZoom/.test(env.html + roomSource),
    'player-content zoom controls are not part of the room interface');
  check(button.getAttribute('aria-label') === 'ملء الشاشة' && !byId.has('videoZoomControls'),
    'fullscreen is the only player magnification action');

  let requestCount = 0;
  let requestOptions = null;
  let exitCount = 0;
  stage.requestFullscreen = (options) => {
    requestCount++;
    requestOptions = options;
    documentStub.fullscreenElement = stage;
    documentStub.dispatch('fullscreenchange', {});
    return Promise.resolve();
  };
  documentStub.exitFullscreen = () => {
    exitCount++;
    documentStub.fullscreenElement = null;
    documentStub.dispatch('fullscreenchange', {});
    return Promise.resolve();
  };

  button.click();
  await wait(15);
  check(requestCount === 1 && requestOptions && requestOptions.navigationUI === 'hide',
    'the click requests native stage fullscreen and asks the browser to hide its navigation UI');
  check(documentStub.fullscreenElement === stage && button.getAttribute('aria-label') === 'الخروج من ملء الشاشة' &&
    byId.get('chatWidget').parentNode === stage,
    'native fullscreen state and the in-fullscreen chat widget are synchronized');

  button.click();
  await wait(15);
  check(exitCount === 1 && !documentStub.fullscreenElement && button.getAttribute('aria-label') === 'ملء الشاشة' &&
    byId.get('chatWidget').parentNode === byId.get('roomMain'),
    'the same button exits fullscreen and restores the room layout');

  stage.requestFullscreen = () => Promise.reject(new Error('denied'));
  button.click();
  await wait(15);
  check(!stage.classList.contains('is-app-fullscreen') && !button.classList.contains('is-on'),
    'a rejected native fullscreen request is not misrepresented as actual fullscreen');

  stage.requestFullscreen = undefined;
  stage.webkitRequestFullscreen = undefined;
  button.click();
  await wait(15);
  check(stage.classList.contains('is-app-fullscreen') && button.getAttribute('aria-label') === 'الخروج من ملء الشاشة',
    'CSS fullscreen remains available only as a fallback when the browser has no native API');
  button.click();
  check(!stage.classList.contains('is-app-fullscreen'), 'the fallback mode can be closed from the player button');

  console.log(`Player fullscreen: ${checks} checks passed (native request, hide-navigation hint, exit, rejection, fallback)`);
} finally {
  env.dispose();
}
