/* Current UI contract: click-to-play, fullscreen, a progress-only bar, fixed four-message window. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = file => readFile(new URL('../../' + file, import.meta.url), 'utf8');
const [html, js, css] = await Promise.all([read('room.html'), read('assets/js/room.js'), read('assets/css/app.css')]);

function elementRange(source, id) {
  const open = source.search(new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid="${id}"`));
  if (open < 0) return null;
  const tag = /^<([a-zA-Z][\w-]*)/.exec(source.slice(open))[1];
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = open;
  let depth = 0, m;
  while ((m = re.exec(source))) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return { start: open, end: m.index + m[0].length };
  }
  return null;
}
const stage = elementRange(html, 'stage');
const player = elementRange(html, 'player');
const bar = elementRange(html, 'ctrlbar');
assert.ok(stage && player && bar);
assert.ok(stage.start < player.start && player.end <= stage.end, 'player inside stage');
assert.ok(player.end <= bar.start && bar.end <= stage.end, 'progress bar below the video, inside stage');
for (const id of ['centerPlayBtn', 'videoFullscreenBtn', 'clickLayer', 'progressBar', 'progressTip']) {
  assert.ok(html.includes(`id="${id}"`), `${id} exists`);
}
for (const id of ['volRange', 'playPauseBtn', 'muteBtn', 'curTime', 'durTime', 'skipBackBtn', 'skipFwdBtn']) {
  assert.ok(!html.includes(`id="${id}"`), `${id} remains removed`);
  assert.ok(!js.includes(`'${id}'`), `${id} is not dereferenced by room.js`);
}
assert.match(js, /if \(el\.videoFullscreen\) el\.videoFullscreen\.addEventListener/);
assert.match(js, /document\.exitFullscreen/);
assert.match(js, /el\.player\.addEventListener\('click'/);
assert.match(js, /player\.load\(parsed, \{ autoplay: !!opts\.autoplay, controls: false \}\)/);
assert.match(js, /el\.ctrlbar\.hidden = parsed\.kind === 'embed'/);
assert.match(js, /player\._video\.controls = false/);
assert.match(js, /skip\(-10\)/);
assert.match(js, /skip\(\+10\)/);
assert.match(css, /\.player\.is-embed \.vclicklayer \{ display: none; \}/, 'embedded controls receive pointer events');
assert.match(css, /\[hidden\] \{ display: none !important; \}/, 'hidden overlays/buttons do not intercept clicks');
assert.match(css, /\.room-body \.ctrlbar\.vcontrols \{[^}]*position: static/);
assert.match(css, /\.room-body \.stage \{[^}]*flex-direction: column/);
assert.match(css, /width: min\(100%, max\(320px, 54vh\)\)/);
assert.match(css, /\.room-main > #chat \.chat__body \{[^}]*height: 256px;[^}]*padding: 0;[^}]*overflow-y: auto/s,
  'four short messages fit in a fixed-height, padding-free scroll area');
assert.match(css, /\.room-main > #chat \.chat__body > \.msg \{[^}]*min-height: 58px/);
assert.match(css, /body\.chat-focus \.room-main > #chat \.chat__body \{[^}]*flex: 1 1 auto/,
  'chat focus can use the available screen height');
assert.doesNotMatch(js, /sizeChatWindow|chatBody\.style\.height/, 'message content must not resize the chat box');
console.log('Player control regression checks passed');
