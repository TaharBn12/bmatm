/* Pure card contracts; the real media/DOM lifecycle is covered in room-browser.mjs. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const context = { URL, URLSearchParams, console };
context.window = context;
vm.createContext(context);
for (const name of ['util', 'icons', 'room-cards']) {
  vm.runInContext(readFileSync(new URL('../../assets/js/' + name + '.js', import.meta.url), 'utf8'), context);
}
const Cards = context.WTRoomCards;
let checks = 0;
for (const url of ['javascript:alert(1)', 'data:video/mp4,test', 'https://name:password@example.com/v.mp4', 'not a URL']) {
  assert.equal(Cards.previewSpec(url), null);
  checks++;
}
assert.equal(Cards.previewSpec('https://example.com/video.webm#t=30').src, 'https://example.com/video.webm');
assert.equal(Cards.previewSpec('https://example.com/watch.m3u8?signature=abc').kind, 'hls');
assert.equal(Cards.previewSpec('https://youtu.be/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ');
assert.equal(Cards.previewSpec('https://untrusted.example/embed/video'), null, 'never autoplay arbitrary iframes with unmuted/unknown APIs');
checks += 4;
for (const [video, start, end] of [
  [{ duration: 12 }, 0, 5], [{ duration: 2 }, 0, 2], [{ duration: NaN }, 0, 5],
  [{ duration: Infinity, seekable: { length: 1, start: () => 20, end: () => 40 } }, 35, 40]
]) {
  assert.equal(Cards.clipWindow(video).start, start);
  assert.equal(Cards.clipWindow(video).end, end);
  checks++;
}
const people = Array.from({ length: 11 }, (_, i) => ({ id: 'person-' + i, name: i ? 'زائر ' + i : '<img onerror="bad()">' }));
const markup = Cards.peopleMarkup({ participants: people, participantCount: 11, presenceKnown: true });
assert.equal((markup.match(/class="room-tile__avatar"/g) || []).length, 5);
assert.match(markup, /dir="ltr"[^>]*>\+6</);
assert.match(markup, /aria-label="11 منضم الآن"/);
assert.match(markup, /&lt;img/);
assert.doesNotMatch(markup, /<img|<script| title="<| style="background:javascript/);
assert.doesNotMatch(Cards.peopleMarkup({ participants: people.slice(0, 5), participantCount: 5, presenceKnown: true }), /room-tile__more/);
assert.doesNotMatch(Cards.peopleMarkup({ participantCount: null, presenceKnown: false }), />0</, 'unknown attendance is not zero');
assert.match(Cards.peopleMarkup({ participants: [], participantCount: 0, presenceKnown: true }), /لا يوجد منضمون الآن/);
checks += 8;
console.log(`Room cards: ${checks} checks passed (five-second windows, safe sources, five avatars/+N, empty/unknown presence and escaping)`);
