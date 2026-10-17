/*
 * Real Chromium regression tests. No live Supabase/YouTube or other external service is used.
 * npm install && npx playwright install chromium && npm run test:browser
 * Optional: WT_PLAYWRIGHT_MODULE, WT_CHROMIUM_EXECUTABLE, WT_CHROMIUM_ARGS (JSON array).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.WT_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = await fs.readFile(new URL('./fixtures/playback.webm', import.meta.url));
const errors = [];
let flakyRequests = 0;
const catalogue = new Map();
let rejectCatalogueCreate = false;
let cataloguePresence = [], cataloguePresenceStatus = 200;

function media(req, res) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), fixture.length - 1) : fixture.length - 1;
  if (start > end) { res.writeHead(416); res.end(); return; }
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${fixture.length}` } : {})
    // Deliberately no Access-Control-Allow-Origin: native video should still play.
  });
  res.end(fixture.subarray(start, end + 1));
}
const mediaServer = http.createServer(media);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://test');
    if (url.pathname.startsWith('/lobby-api/rest/v1/')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (url.pathname.endsWith('/rpc/wt_create_room') && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (rejectCatalogueCreate) { res.writeHead(403); res.end(JSON.stringify({ message: 'تعذّرت إضافة الغرفة' })); return; }
        assert.match(data.p_owner_token, /^[a-f0-9]{64}$/);
        catalogue.set(data.p_room_id, { room_id: data.p_room_id, title: data.p_title, video_url: data.p_video_url, created_at: new Date().toISOString() });
        res.end(JSON.stringify({ ok: true }));
      } else if (url.pathname.endsWith('/presence') && req.method === 'GET') {
        if (cataloguePresenceStatus !== 200) { res.writeHead(cataloguePresenceStatus); res.end('{}'); return; }
        assert.equal(url.searchParams.get('select'), 'room_id,client_id,name,last_seen');
        const offset = Number(url.searchParams.get('offset') || 0);
        const rows = cataloguePresence.filter(person => person.last_seen >= url.searchParams.get('last_seen').slice(4));
        // Deliberately cap pages below the client's limit, exercising Content-Range pagination.
        const page = rows.slice(offset, offset + 3);
        res.setHeader('Content-Range', page.length ? `${offset}-${offset + page.length - 1}/${rows.length}` : `*/${rows.length}`);
        res.end(JSON.stringify(page));
      } else if (url.pathname.endsWith('/rooms') && req.method === 'GET') {
        res.end(JSON.stringify(Array.from(catalogue.values())));
      } else { res.writeHead(404); res.end('{}'); }
      return;
    }
    if (url.pathname === '/flaky.webm') {
      if (++flakyRequests === 1) { res.writeHead(404); res.end('temporary failure'); }
      else media(req, res);
      return;
    }
    if (url.pathname === '/embed-fixture') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><body style="margin:0;background:#222;color:white"><button id="embedPlay" style="width:100%;height:100vh" onclick="this.dataset.playing=\'true\';this.textContent=\'Playing\'">Play embedded video</button></body></html>');
      return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    const body = await fs.readFile(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.webm': 'video/webm', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
const listen = server => new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
await Promise.all([listen(server), listen(mediaServer)]);
const base = `http://localhost:${server.address().port}`;
const videoUrl = `http://localhost:${mediaServer.address().port}/playback.webm`;
const launchOptions = {
  headless: true,
  ...(process.env.WT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.WT_CHROMIUM_EXECUTABLE } : {}),
  args: JSON.parse(process.env.WT_CHROMIUM_ARGS || '["--no-sandbox"]')
};
const contexts = [], browsers = [];
async function makePage(device, init = {}, sharedContext = null) {
  let context = sharedContext;
  if (!context) {
    const browser = await chromium.launch(launchOptions);
    browsers.push(browser);
    context = await browser.newContext({ reducedMotion: 'reduce', ...device });
    contexts.push(context);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.bringToFront();
  page.on('pageerror', error => errors.push(error.stack));
  page.on('dialog', dialog => dialog.accept());
  if (process.env.WT_BROWSER_DEBUG) {
    page.on('request', req => console.log('request', req.url()));
    page.on('response', res => console.log('response', res.status(), res.url()));
    page.on('requestfailed', req => console.log('failed', req.url(), req.failure()));
    page.on('console', msg => console.log('console', msg.type(), msg.text()));
  }
  await page.routeWebSocket('**', socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if ([base, new URL(videoUrl).origin].includes(url.origin)) return route.continue();
    if (init.stallAuth && url.pathname.startsWith('/auth/v1/')) return; // simulate stalled network
    return route.abort();
  });
  if (init.catalogue) {
    const source = await fs.readFile(path.join(root, 'assets/js/config.js'), 'utf8');
    await page.route('**/assets/js/config.js?*', route => route.fulfill({
      contentType: 'application/javascript', body: source + '\nWT_CONFIG.javaServer.enabled = false; WT_CONFIG.supabase.url = ' +
        JSON.stringify(base + '/lobby-api') + '; WT_CONFIG.supabase.ready = true; WT_CONFIG.supabase.auth = false;'
    }));
  }
  await page.addInitScript(({ account, owner }) => {
    if (!sessionStorage.getItem('test:initialized')) {
      if (account) localStorage.setItem('wt:session', JSON.stringify(account));
      if (owner) localStorage.setItem('wt:owner:BRTEST', JSON.stringify('b'.repeat(64)));
      sessionStorage.setItem('test:initialized', '1');
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.testCopied = text; }, readText: async () => ''
    } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.testShare = data; } });
  }, init);
  return page;
}
const waitFor = (page, predicate, arg) => page.waitForFunction(predicate, arg, { polling: 50 });
const waitReady = page => waitFor(page, () => window.WTRoom?.session.ready);
const waitVideo = async page => {
  try { await waitFor(page, () => window.WTRoom?.player.isReady()); }
  catch (error) {
    console.error('Media diagnostic:', await page.evaluate(() => ({
      playerState: window.WTRoom?.player.state, visibility: document.visibilityState, focus: document.hasFocus(),
      video: WTRoom.player._video && { src: WTRoom.player._video.src, readyState: WTRoom.player._video.readyState, error: WTRoom.player._video.error?.message },
      message: document.querySelector('.player__overlay--loading .player__overlay-text')?.textContent
    })));
    throw error;
  }
};
async function enter(page, query, name = 'اختبار الغرفة') {
  await page.goto(`${base}/room.html?local=1&id=BRTEST${query || ''}`);
  await page.fill('#gateName', name);
  await page.click('#gateSubmit');
  await waitReady(page);
}
async function addQueue(page, url, title) {
  await page.click('#addVideoBtn');
  await page.fill('#newUrl', url);
  await page.fill('#newTitle', title);
  await page.click('#applyUrlBtn');
  await waitFor(page, title => WTRoom.session.queue.some(item => item.title === title), title);
}
async function assertChatWindow(page, visibleRows, total, overflow) {
  const metrics = await page.evaluate(limit => {
    const body = document.getElementById('chatBody');
    const rows = Array.from(body.querySelectorAll('.msg'));
    const recent = rows.slice(-limit);
    const style = getComputedStyle(body);
    const expected = Math.ceil(recent.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0)
      + (parseFloat(style.rowGap) || 0) * Math.max(0, recent.length - 1)
      + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0));
    return { total: rows.length, height: body.clientHeight, expected, overflow: body.scrollHeight > body.clientHeight + 1 };
  }, visibleRows);
  assert.equal(metrics.total, total, 'older messages remain in the DOM');
  assert.ok(Math.abs(metrics.height - metrics.expected) <= 1, `${visibleRows}-row chat window: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.overflow, overflow, `scrollbar threshold for ${visibleRows} visible rows`);
}

try {
  for (const [name, device] of [
    ['desktop', { viewport: { width: 1280, height: 900 } }],
    ['mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]
  ]) {
    const page = await makePage(device);
    /* Minimal lobby: floating plus/X, persistent cards, and guest name confirmation. */
    await page.goto(`${base}/index.html?local=1`);
    assert.equal(await page.locator('.hero, .features, .steps, .site-footer, [href="discover.html"]').count(), 0);
    assert.equal(await page.locator('#creator').isVisible(), false);
    await page.click('#createToggle');
    assert.equal(await page.locator('#createToggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#createToggle').getAttribute('aria-label'), 'إغلاق إضافة الغرفة');
    await page.click('#createBtn');
    assert.equal(await page.locator('#createError').textContent(), 'أدخل اسم الغرفة');
    await page.fill('#roomTitle', 'سهرة الاختبار');
    await page.fill('#videoUrl', videoUrl);
    await page.click('#createToggle');
    assert.equal(await page.locator('#creator').isVisible(), false);
    await page.click('#createToggle');
    assert.equal(await page.locator('#roomTitle').inputValue(), 'سهرة الاختبار', 'closing preserves a draft');
    const panelRect = await page.locator('#creator').boundingBox();
    assert.ok(panelRect.x >= 0 && panelRect.x + panelRect.width <= device.viewport.width && panelRect.y >= 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#createToggle').getAttribute('aria-expanded'), 'false');
    await page.click('#createToggle');
    await page.click('#createBtn');
    await waitFor(page, () => document.querySelectorAll('.room-tile').length === 1);
    assert.ok(page.url().includes('index.html'), 'creation adds a card without entering the room');
    assert.equal(await page.locator('#creator').isVisible(), false);
    await page.reload();
    await waitFor(page, () => document.querySelectorAll('.room-tile').length === 1);
    assert.equal(await page.locator('.room-tile__title').textContent(), 'سهرة الاختبار');
    const cardCover = await page.locator('.room-tile__cover').boundingBox();
    const cardBody = await page.locator('.room-tile__body').boundingBox();
    assert.ok(cardCover.x + cardCover.width <= cardBody.x + 1, 'the cover stays physically left, including in RTL');
    assert.equal(await page.locator('.room-tile__people').getAttribute('aria-label'), 'لا يوجد منضمون الآن');
    assert.doesNotMatch(await page.locator('.room-tile').getAttribute('href'), /host=|auto=|owner|token/i);
    await page.locator('.room-tile').click();
    await page.waitForURL('**/room.html?**');
    assert.equal(await page.locator('#gate').isVisible(), true, 'guest creator must enter a name too');
    await page.fill('#gateName', 'فاحص الغرفة');
    await page.click('#gateSubmit');
    await waitReady(page);
    await waitVideo(page);
    assert.equal(await page.evaluate(() => WTRoom.session.role), 'owner');
    assert.equal(await page.evaluate(() => WTRoom.player._video.crossOrigin), null);
    assert.ok(await page.locator('#centerPlayBtn').isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');

    /* Real decode, fullscreen, play/pause, pointer seeking and keyboard seeking. */
    await page.click('#videoFullscreenBtn');
    await waitFor(page, () => document.fullscreenElement?.id === 'stage');
    await page.click('#videoFullscreenBtn');
    await waitFor(page, () => !document.fullscreenElement);
    await page.click('#centerPlayBtn');
    await waitFor(page, () => WTRoom.player.isPlaying() && WTRoom.player.getCurrentTime() > 0.2);
    await page.locator('#clickLayer').click({ position: { x: 20, y: 20 } });
    await waitFor(page, () => !WTRoom.player.isPlaying());
    assert.equal(await page.evaluate(() => WTRoom.state.playing), false);
    const progress = await page.locator('#progressBar').boundingBox();
    await page.mouse.click(progress.x + progress.width * 0.25, progress.y + progress.height / 2);
    await waitFor(page, () => Math.abs(WTRoom.player.getCurrentTime() - 9) < 0.6);
    const beforeKey = await page.evaluate(() => WTRoom.player.getCurrentTime());
    await page.focus('#progressBar');
    await page.keyboard.press('ArrowRight');
    await waitFor(page, before => Math.abs(WTRoom.player.getCurrentTime() - (before - 5)) < 0.1, beforeKey);

    /* Form buttons, shared queue play/remove, and cleanup of the previous frame. */
    await page.click('#addVideoBtn');
    await page.fill('#newUrl', 'not a URL');
    await page.click('#applyUrlBtn');
    assert.ok(await page.locator('#changeBar').isVisible());
    await page.click('#cancelUrlBtn');
    await addQueue(page, videoUrl + '?next=1', 'المقطع التالي');
    await page.click('#playlistBtn');
    await page.locator('[data-play-queue]').click();
    await waitVideo(page);
    assert.equal(await page.locator('#player .player__frame').count(), 1);
    assert.ok((await page.evaluate(() => WTRoom.state.url)).endsWith('?next=1'));
    await page.click('#playlistBtn');
    await page.locator('[data-remove-queue]').click();
    await waitFor(page, () => WTRoom.session.queue.length === 0);
    await page.click('#playlistCloseBtn');

    /* Chat submit/Enter/reaction, focus mode and cancel/clear are actual pointer/keyboard actions. */
    await page.fill('#chatInput', 'رسالة بزر الإرسال');
    await page.click('#chatSend');
    assert.equal(await page.locator('#chatInput').inputValue(), '');
    assert.ok(await page.locator('.msg__text').filter({ hasText: 'رسالة بزر الإرسال' }).isVisible());
    await page.waitForTimeout(380);
    await page.fill('#chatInput', 'رسالة بمفتاح الدخول');
    await page.press('#chatInput', 'Enter');
    assert.ok(await page.locator('.msg__text').filter({ hasText: 'رسالة بمفتاح الدخول' }).isVisible());
    await page.waitForTimeout(380);
    await page.locator('[data-react="👍"]').click();
    const emojiRow = page.locator('#chatBody .msg--me').last();
    assert.equal(await emojiRow.locator('.msg__text').textContent(), '👍');
    assert.ok(await emojiRow.locator('.msg__name').isVisible());
    assert.ok(await emojiRow.locator('.msg__time').isVisible());
    assert.equal(await emojiRow.evaluate(row => getComputedStyle(row).flexDirection), 'row-reverse');
    assert.equal(await page.locator('.msg--react, .react-bubble').count(), 0, 'emoji are ordinary messages, not centered rows');
    const beforeReactions = await page.locator('#chatBody .msg').count();
    const addReaction = emojiRow.locator('.msg__react-add');
    if (device.hasTouch) await addReaction.tap();
    else await addReaction.click();
    const picker = page.locator('.msg-menu');
    assert.ok(await picker.isVisible());
    const menuRect = await picker.boundingBox();
    assert.ok(menuRect.x >= 9 && menuRect.y >= 9 && menuRect.x + menuRect.width <= device.viewport.width - 9 &&
      menuRect.y + menuRect.height <= device.viewport.height - 9, 'reaction picker stays inside the viewport');
    await picker.locator('[data-emoji="❤️"]').click();
    assert.equal(await emojiRow.locator('.msg__reaction').textContent(), '❤️ 1');
    assert.equal(await emojiRow.locator('.msg__reaction').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#chatBody .msg').count(), beforeReactions, 'reaction adds no chat row');
    await addReaction.focus();
    await page.keyboard.press('Enter');
    assert.equal(await picker.locator('[data-emoji="❤️"]').getAttribute('aria-pressed'), 'true');
    await picker.locator('[data-emoji="😂"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await emojiRow.locator('.msg__reaction').textContent(), '😂 1', 'choosing another emoji replaces my reaction');
    await emojiRow.locator('.msg__reaction').click();
    assert.equal(await emojiRow.locator('.msg__reaction').count(), 0, 'clicking my reaction removes it');
    if (device.hasTouch) {
      await emojiRow.locator('.msg__text').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 100, clientY: 300 });
      await page.waitForTimeout(500);
      await emojiRow.locator('.msg__text').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7, clientX: 100, clientY: 300 });
    } else await emojiRow.locator('.msg__text').click({ button: 'right' });
    assert.ok(await picker.isVisible(), 'long press/right click also exposes emoji reactions');
    await picker.locator('[data-emoji="🔥"]').click();
    assert.equal(await emojiRow.locator('.msg__reaction').textContent(), '🔥 1');
    await page.click('#messagesBtn');
    await addReaction.click();
    await page.keyboard.press('Escape');
    assert.equal(await picker.isVisible(), false);
    assert.equal(await page.locator('#stage').isVisible(), false, 'Escape closes picker before exiting chat focus');
    assert.equal(await page.locator('#stage').isVisible(), false);
    await page.click('#messagesBtn');
    await page.waitForTimeout(120);
    assert.ok(await page.locator('#stage').isVisible());
    await page.click('#clearChatBtn');
    assert.equal(await page.locator('#chatBody .msg').count(), 0);

    /* Twelve rows fit without internal scrolling only when the video is hidden. */
    await page.evaluate(() => {
      for (let i = 1; i <= 12; i++) WTRoom.chat.addChatMessage({
        id: 'window-' + i, client: 'window-test', name: 'فاحص', text: 'رسالة تجريبية ' + i, ts: Date.now(), kind: 'chat'
      }, { silent: true });
    });
    await assertChatWindow(page, 8, 12, true);
    await page.click('#messagesBtn');
    assert.equal(await page.locator('#stage').isVisible(), false);
    await assertChatWindow(page, 12, 12, false);
    await page.locator('#chatBody .msg').last().locator('.msg__react-add').click();
    await page.locator('.msg-menu__reaction[data-emoji="🔥"]').click();
    await assertChatWindow(page, 12, 12, false);
    await page.evaluate(() => WTRoom.chat.addChatMessage({
      id: 'window-13', client: 'window-test', name: 'فاحص', text: 'الرسالة الثالثة عشرة', ts: Date.now(), kind: 'chat'
    }));
    await assertChatWindow(page, 12, 13, true);
    await page.evaluate(() => document.getElementById('chatBody').scrollTo({ top: 0, behavior: 'instant' }));
    await waitFor(page, () => document.getElementById('chatBody').scrollTop === 0);
    assert.ok(await page.evaluate(() => {
      const body = document.getElementById('chatBody').getBoundingClientRect();
      const first = document.querySelector('#chatBody .msg').getBoundingClientRect();
      return first.top >= body.top && first.bottom <= body.bottom;
    }), 'scrolling reaches older messages');
    await page.click('#messagesBtn');
    await assertChatWindow(page, 8, 13, true);
    await page.click('#clearChatBtn');
    assert.equal(await page.locator('#chatBody .msg').count(), 0);

    /* Drawer, copy/share, QR, account save, diagnostics and reconnect. */
    await page.click('#drawerOpenBtn');
    await page.click('#copyCodeBtn');
    assert.equal(await page.evaluate(() => window.testCopied), await page.evaluate(() => WTRoom.roomId));
    await page.click('#copyLinkBtn');
    assert.match(await page.evaluate(() => window.testCopied), /room\.html\?id=.+&v=/);
    assert.doesNotMatch(await page.evaluate(() => window.testCopied), /ownerToken|owner_token/);
    await page.click('#shareBtn');
    assert.match(await page.evaluate(() => window.testShare.url), /room\.html\?id=/);
    await page.click('#qrBtn');
    assert.equal(await page.locator('#qrBox img').count(), 1);
    await page.click('#qrCopy');
    await page.click('#qrClose');
    await page.click('#sbMeBtn');
    await page.fill('#meNameInput', 'اسم جديد');
    await page.click('#meSave');
    await waitFor(page, () => WTRoom.session.name === 'اسم جديد');
    await page.click('#sbMeBtn');
    await page.press('#meNameInput', 'Escape');
    assert.equal(await page.locator('#meModal').isVisible(), false);
    await page.click('#diagBtn');
    await waitFor(page, () => WTRoom.session.lastReport);
    await page.click('#diagCopyBtn');
    assert.match(await page.evaluate(() => window.testCopied), /WatchTogether/);
    const oldReport = await page.evaluate(() => WTRoom.session.lastReport.at);
    await page.click('#diagRunBtn');
    await waitFor(page, at => WTRoom.session.lastReport.at > at, oldReport);
    await page.click('#diagCloseBtn');
    await page.click('#diagBtn');
    await page.click('#diagReconnectBtn');
    await waitReady(page);
    await page.click('#drawerCloseBtn');
    await page.click('#drawerOpenBtn');
    await page.locator('#drawerScrim').click({ position: { x: 5, y: 20 } });
    assert.equal(await page.locator('#drawerOpenBtn').getAttribute('aria-expanded'), 'false');

    /* An iframe's own button must receive the click, not the transparent click-to-play layer. */
    await addQueue(page, base + '/embed-fixture', 'مشغّل مضمّن');
    await page.click('#playlistBtn');
    await page.locator('[data-play-queue]').click();
    await waitVideo(page);
    const embedded = page.frameLocator('#player iframe').locator('#embedPlay');
    await embedded.click();
    assert.equal(await embedded.getAttribute('data-playing'), 'true');
    assert.equal(await page.locator('#unblockPlay').count(), 0, 'no fake autoplay prompt over an external iframe');

    await page.click('#drawerOpenBtn');
    await page.click('#leaveBtn');
    await page.waitForURL('**/index.html');
    console.log(`Browser ${name}: create, playback, seek, fullscreen, room buttons, chat, queue, embed, leave passed`);
    await page.context().browser().close();
  }

  /* Account cards enter directly; an empty room is valid and needs no initial video. */
  const lobbyAccount = await makePage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, {
    account: { access_token: 'account-token', refresh_token: 'refresh-token', expires_at: Date.now() + 3600000,
      user: { id: 'lobby-account', name: 'صاحب الحساب', email: 'test@example.com' } }
  });
  await lobbyAccount.goto(`${base}/index.html?local=1`);
  await lobbyAccount.click('#createToggle');
  await lobbyAccount.fill('#roomTitle', 'غرفة بدون فيديو');
  await lobbyAccount.click('#createBtn');
  await waitFor(lobbyAccount, () => !!document.querySelector('.room-tile'));
  await lobbyAccount.locator('.room-tile').click();
  await waitReady(lobbyAccount);
  assert.equal(await lobbyAccount.locator('#gate').isVisible(), false);
  assert.equal(await lobbyAccount.evaluate(() => WTRoom.session.name), 'صاحب الحساب');
  assert.equal(await lobbyAccount.evaluate(() => WTRoom.session.isGuest), false);
  assert.equal(await lobbyAccount.evaluate(() => WTRoom.session.role), 'owner');
  assert.ok(await lobbyAccount.locator('#playerPlaceholder').isVisible());
  await lobbyAccount.evaluate(() => { WTAuth.clearSession(); WTAuth.signInAsGuest('ضيف محفوظ'); });
  await lobbyAccount.goto(`${base}/index.html?local=1`);
  await lobbyAccount.locator('.room-tile').click();
  assert.equal(await lobbyAccount.locator('#gate').isVisible(), true, 'saved guest sessions still confirm a name');
  await waitFor(lobbyAccount, () => !!window.WTRoom);
  assert.equal(await lobbyAccount.locator('#gateName').inputValue(), 'ضيف محفوظ');
  await lobbyAccount.fill('#gateName', 'ضيف جديد');
  await lobbyAccount.click('#gateSubmit');
  await waitReady(lobbyAccount);
  assert.equal(await lobbyAccount.evaluate(() => WTRoom.session.userId), null);
  await lobbyAccount.goto(`${base}/discover.html?local=1`);
  await lobbyAccount.waitForURL('**/index.html?local=1');
  assert.equal(await lobbyAccount.locator('#siteCards, #siteViewer').count(), 0);
  await lobbyAccount.context().browser().close();
  console.log('Browser lobby: plus/X, persisted room cards, empty-room creation, account auto-entry and guest name gate passed');

  /* Real HTTP catalogue contract, isolated browser storage: all visitors see created rooms. */
  const publicLobby = await makePage({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true }, { catalogue: true });
  await publicLobby.goto(`${base}/index.html`);
  await waitFor(publicLobby, () => document.getElementById('roomsList').getAttribute('aria-busy') === 'false');
  assert.equal(await publicLobby.locator('.room-tile').count(), 0);
  await publicLobby.click('#createToggle');
  const smallPanel = await publicLobby.locator('#creator').boundingBox();
  assert.ok(smallPanel.x >= 0 && smallPanel.x + smallPanel.width <= 320 && smallPanel.y >= 0);
  await publicLobby.fill('#roomTitle', 'غرفة للجميع');
  rejectCatalogueCreate = true;
  await publicLobby.click('#createBtn');
  await waitFor(publicLobby, () => !document.getElementById('createBtn').disabled);
  assert.equal(await publicLobby.locator('.room-tile').count(), 0, 'failed creation must not add a fake card');
  assert.ok(await publicLobby.locator('#createError').isVisible());
  assert.equal(await publicLobby.locator('#roomTitle').inputValue(), 'غرفة للجميع');
  rejectCatalogueCreate = false;
  await publicLobby.click('#createBtn');
  await waitFor(publicLobby, () => !!document.querySelector('.room-tile'));
  const publicId = await publicLobby.locator('.room-tile').getAttribute('data-room-id');
  assert.equal(await publicLobby.locator('#homeStatus').isVisible(), false, 'shared mode is not mislabeled as local');
  const publicVisitor = await makePage({ viewport: { width: 1280, height: 900 } }, { catalogue: true });
  await publicVisitor.goto(`${base}/index.html`);
  await waitFor(publicVisitor, () => !!document.querySelector('.room-tile'));
  assert.equal(await publicVisitor.locator('.room-tile__title').textContent(), 'غرفة للجميع');
  assert.equal(await publicVisitor.evaluate(id => localStorage.getItem('wt:owner:' + id), publicId), null, 'public card does not transfer owner credentials');
  assert.equal(await publicVisitor.locator('.room-tile').getAttribute('href'), 'room.html?id=' + publicId);
  await publicVisitor.reload();
  await waitFor(publicVisitor, () => !!document.querySelector('.room-tile'));
  catalogue.clear();
  await publicVisitor.click('#refreshRooms');
  await waitFor(publicVisitor, () => document.querySelectorAll('.room-tile').length === 0);
  assert.ok(await publicVisitor.locator('#roomsEmpty').isVisible());
  assert.ok(await publicVisitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await publicLobby.context().browser().close();
  await publicVisitor.context().browser().close();
  console.log('Browser shared lobby: real HTTP create/list, failed-write recovery, isolated visitors, reload and refresh passed');

  /* Card covers play a real five-second silent window without joining/controlling a room. */
  catalogue.set('CLIP01', { room_id: 'CLIP01', title: 'سهرة المشاهدة', video_url: 'https://media.example/original.mp4', current_video_url: videoUrl, created_at: new Date().toISOString() });
  const freshPeople = count => Array.from({ length: count }, (_, i) => ({ room_id: 'CLIP01', client_id: 'viewer-' + i, name: 'منضم ' + (i + 1), last_seen: new Date().toISOString() }));
  cataloguePresence = freshPeople(11);
  const previewLobby = await makePage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' }, { catalogue: true });
  await previewLobby.goto(`${base}/index.html`);
  await waitFor(previewLobby, () => document.querySelector('.room-tile__preview')?.currentTime > 0.3);
  const previewCard = previewLobby.locator('[data-room-id="CLIP01"]');
  assert.equal(await previewCard.locator('.room-tile__avatar').count(), 5);
  assert.equal(await previewCard.locator('.room-tile__more').textContent(), '+6');
  assert.equal(await previewCard.locator('.room-tile__more').getAttribute('dir'), 'ltr');
  assert.equal(await previewCard.locator('.room-tile__people').getAttribute('aria-label'), '11 منضم الآن');
  assert.ok(await previewLobby.evaluate(() => {
    const video = document.querySelector('.room-tile__preview');
    return video.muted && video.volume === 0 && !video.controls && video.playsInline && !window.WTRoom;
  }), 'a muted preview is not an active room participant/player');
  await previewLobby.evaluate(() => {
    window.cardVideo = document.querySelector('.room-tile__preview'); window.previewLoops = 0;
    cardVideo.addEventListener('seeked', () => { if (cardVideo.currentTime < 1) window.previewLoops++; });
  });
  await waitFor(previewLobby, () => window.previewLoops >= 1);
  assert.ok(await previewLobby.evaluate(() => cardVideo.currentTime < 5.2), 'the 12-second fixture loops only its five-second cover window');
  const refreshPreview = async () => {
    cataloguePresence.forEach(person => { person.last_seen = new Date().toISOString(); });
    await previewLobby.click('#refreshRooms');
    await waitFor(previewLobby, () => document.getElementById('roomsList').getAttribute('aria-busy') === 'false');
  };
  await refreshPreview();
  assert.ok(await previewLobby.evaluate(() => cardVideo === document.querySelector('.room-tile__preview')), 'refreshing presence does not replace/restart the preview');
  await previewLobby.setViewportSize({ width: 320, height: 568 });
  let left = await previewCard.locator('.room-tile__cover').boundingBox();
  let right = await previewCard.locator('.room-tile__body').boundingBox();
  assert.ok(left.x + left.width <= right.x + 1);
  assert.ok(await previewLobby.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'five avatars and +6 fit at 320px');
  const stack = await previewCard.locator('.room-tile__people').boundingBox();
  assert.ok(stack.x >= right.x && stack.x + stack.width <= right.x + right.width);
  cataloguePresence = freshPeople(2);
  await refreshPreview();
  assert.equal(await previewCard.locator('.room-tile__avatar').count(), 2);
  assert.equal(await previewCard.locator('.room-tile__more').count(), 0);
  cataloguePresenceStatus = 503;
  await refreshPreview();
  assert.ok(await previewCard.locator('.room-tile__people.is-unknown').isVisible());
  cataloguePresenceStatus = 200; cataloguePresence = [];
  await refreshPreview();
  assert.equal(await previewCard.locator('.room-tile__people').getAttribute('aria-label'), 'لا يوجد منضمون الآن');
  cataloguePresence = freshPeople(11);
  await refreshPreview();
  await previewLobby.emulateMedia({ reducedMotion: 'reduce' });
  await waitFor(previewLobby, () => cardVideo.paused);
  const stillTime = await previewLobby.evaluate(() => cardVideo.currentTime);
  await previewLobby.waitForTimeout(200);
  assert.ok(Math.abs(await previewLobby.evaluate(() => cardVideo.currentTime) - stillTime) < 0.1, 'reduced motion keeps a still cover');
  await previewLobby.emulateMedia({ reducedMotion: 'no-preference' });
  await waitFor(previewLobby, () => !cardVideo.paused);
  catalogue.get('CLIP01').current_video_url = `${base}/missing-cover.webm`;
  await refreshPreview();
  await waitFor(previewLobby, () => !document.querySelector('.room-tile__preview'));
  assert.ok(await previewCard.isVisible(), 'a failed cover never removes the room card');
  assert.equal(await previewCard.getAttribute('href'), 'room.html?id=CLIP01');
  catalogue.get('CLIP01').current_video_url = videoUrl + '?changed=1';
  await refreshPreview();
  await waitFor(previewLobby, () => document.querySelector('.room-tile__preview')?.currentTime > 0.1);
  assert.ok(await previewLobby.evaluate(() => cardVideo.paused && !cardVideo.hasAttribute('src')));
  assert.ok(await previewLobby.locator('.room-tile__preview').evaluate(video => video.currentSrc.includes('changed=1')), 'the cover follows the current queued source, not the original room URL');
  const hlsUrl = `${base}/docs/tests/fixtures/hls/playback.m3u8`;
  catalogue.get('CLIP01').current_video_url = hlsUrl;
  await refreshPreview();
  await waitFor(previewLobby, () => document.querySelector('.room-tile__preview')?.currentTime > 0.2);
  await previewLobby.evaluate(() => {
    window.originalCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) { return /mpegurl/i.test(type) ? '' : originalCanPlayType.call(this, type); };
  });
  catalogue.get('CLIP01').current_video_url = hlsUrl + '?library=1';
  await refreshPreview();
  await waitFor(previewLobby, () => !!window.Hls && document.querySelector('.room-tile__preview')?.currentTime > 0.2);
  assert.ok(await previewLobby.locator('.room-tile__preview').evaluate(video => video.currentSrc.startsWith('blob:')), 'browsers without native HLS decode via the bundled library');
  await previewLobby.evaluate(() => {
    window.hlsLoops = 0;
    document.querySelector('.room-tile__preview').addEventListener('seeked', event => { if (event.target.currentTime < 1) window.hlsLoops++; });
  });
  await waitFor(previewLobby, () => window.hlsLoops >= 1);
  await previewLobby.evaluate(() => { HTMLMediaElement.prototype.canPlayType = originalCanPlayType; });
  await previewLobby.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(previewLobby, () => !document.querySelector('.room-tile__preview'));
  await previewLobby.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(previewLobby, () => document.querySelector('.room-tile__preview')?.currentTime > 0.1);

  /* Provider boundaries are tested with a local response, never the live YouTube service. */
  await previewLobby.route('https://www.youtube-nocookie.com/embed/**', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html><body style="background:#273147"><script>window.commands=[]; addEventListener("message", e => { const m=JSON.parse(e.data); if(m.event==="command") commands.push(m); if(m.event==="listening") parent.postMessage(JSON.stringify({event:"onReady"}), e.origin); });</script></body></html>'
  }));
  catalogue.get('CLIP01').current_video_url = 'https://youtu.be/dQw4w9WgXcQ';
  await refreshPreview();
  await waitFor(previewLobby, () => document.querySelector('.room-tile').classList.contains('has-preview') && !!document.querySelector('.room-tile__youtube'));
  const youtube = previewCard.locator('iframe');
  const youtubeURL = new URL(await youtube.getAttribute('src'));
  assert.equal(youtubeURL.searchParams.get('end'), '5');
  assert.equal(youtubeURL.searchParams.get('mute'), '1');
  assert.equal(youtubeURL.searchParams.get('loop'), '1');
  const youtubeFrame = previewLobby.frames().find(frame => frame.url().startsWith('https://www.youtube-nocookie.com/embed/'));
  await youtubeFrame.evaluate(() => parent.postMessage(JSON.stringify({ event: 'infoDelivery', info: { currentTime: 5.2 } }), '*'));
  await youtubeFrame.waitForFunction(() => commands.filter(m => m.func === 'seekTo').length >= 2);
  await previewLobby.evaluate(() => dispatchEvent(new MessageEvent('message', { source: window, origin: 'https://www.youtube-nocookie.com', data: { event: 'onError' } })));
  assert.equal(await youtube.count(), 1, 'unrelated windows cannot affect a preview with forged player messages');
  catalogue.get('CLIP01').current_video_url = 'https://untrusted.example/embed/video';
  await refreshPreview();
  assert.equal(await previewCard.locator('iframe, video').count(), 0, 'unknown embeds cannot autoplay audio or arbitrary pages in the lobby');
  catalogue.get('CLIP01').current_video_url = videoUrl;
  for (let i = 1; i < 14; i++) catalogue.set('CLIP' + String(i + 1).padStart(2, '0'), { room_id: 'CLIP' + String(i + 1).padStart(2, '0'), title: 'غرفة ' + i, video_url: videoUrl, created_at: new Date(Date.now() - 3600000 - i * 1000).toISOString() });
  await refreshPreview();
  await previewLobby.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await waitFor(previewLobby, () => !document.querySelector('[data-room-id="CLIP01"] video'));
  assert.ok(await previewLobby.locator('video.room-tile__preview').count() <= 6, 'offscreen covers release decoders and downloads');
  await previewLobby.evaluate(() => scrollTo(0, 0));
  await waitFor(previewLobby, () => !!document.querySelector('[data-room-id="CLIP01"] video'));
  await previewLobby.evaluate(() => {
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }); dispatchEvent(new Event('resize'));
  });
  await waitFor(previewLobby, () => !document.querySelector('video.room-tile__preview'));
  await previewLobby.evaluate(() => { delete navigator.connection; dispatchEvent(new Event('resize')); });
  await previewCard.click({ position: { x: 30, y: 45 } });
  await previewLobby.waitForURL(/room\.html\?id=CLIP01/);
  await waitFor(previewLobby, () => !!window.WTRoom);
  assert.ok(await previewLobby.locator('#gate').isVisible(), 'clicking the left cover still opens the guest name gate');
  catalogue.clear(); cataloguePresence = [];
  await previewLobby.context().browser().close();
  console.log('Browser room cards: real 5s silent WebM/HLS loops, native/library HLS, left/right layout at 320px, five avatars/+6, live roster, stable refresh, media changes, fallbacks, YouTube contract, motion/data limits and cleanup passed');

  /* Two actual tabs: BroadcastChannel + storage delivery, counts and reload/replay. */
  const first = await makePage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await enter(first, '', 'أمين');
  const second = await makePage({}, {}, first.context());
  await enter(second, '', 'سليم');
  await first.bringToFront();
  await first.fill('#chatInput', 'رسالة مشتركة للتفاعل');
  await first.click('#chatSend');
  await waitFor(second, () => !!document.querySelector('.msg__react-add'));
  const message = page => page.locator('#chatBody .msg').filter({ has: page.locator('.msg__text', { hasText: 'رسالة مشتركة للتفاعل' }) });
  const choose = async (page, emoji) => {
    await page.bringToFront();
    await message(page).locator('.msg__react-add').tap();
    await page.locator('.msg-menu__reaction').filter({ hasText: emoji }).click();
  };
  await choose(second, '❤️');
  await waitFor(first, () => document.querySelector('.msg__reaction')?.textContent === '❤️ 1');
  await choose(first, '❤️');
  await waitFor(second, () => document.querySelector('.msg__reaction')?.textContent === '❤️ 2');
  assert.equal(await message(first).locator('.msg__reaction').textContent(), '❤️ 2');
  await choose(second, '😂');
  await waitFor(first, () => Array.from(document.querySelectorAll('.msg__reaction')).map(b => b.textContent).join('|') === '❤️ 1|😂 1');
  await second.reload();
  await second.fill('#gateName', 'سليم');
  await second.click('#gateSubmit');
  await waitReady(second);
  assert.equal(await message(second).locator('.msg__reaction').count(), 2, 'history restores reactions, not extra messages');
  assert.equal(await message(second).locator('[data-emoji="😂"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await message(second).locator('[data-emoji="❤️"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await second.locator('#chatBody .msg__text').count(), 1);
  await message(second).locator('[data-emoji="😂"]').tap();
  await waitFor(first, () => document.querySelectorAll('.msg__reaction').length === 1);
  assert.equal(await message(first).locator('.msg__reaction').textContent(), '❤️ 1');
  await first.bringToFront();
  await message(first).locator('.msg__react-add').tap();
  await first.locator('.msg-menu__btn[data-act="delete"]').click();
  await waitFor(second, () => !!document.querySelector('.msg--deleted'));
  assert.equal(await second.locator('.msg__reaction, .msg__react-add').count(), 0, 'deletion removes reactions on both tabs');
  assert.equal(await first.locator('.msg__reaction, .msg__react-add').count(), 0);
  assert.deepEqual(errors, []);
  await first.evaluate(() => WTUtil.store.set('local:rooms', [{ id: 'BRTEST', title: 'سهرة الأصدقاء', videoUrl: '', createdAt: Date.now() }]));
  const attendanceLobby = await makePage({ viewport: { width: 390, height: 844 } }, {}, first.context());
  await attendanceLobby.goto(`${base}/index.html?local=1`);
  await waitFor(attendanceLobby, () => document.querySelector('.room-tile__people')?.getAttribute('aria-label') === '2 منضم الآن');
  assert.equal(await attendanceLobby.locator('.room-tile__avatar').count(), 2, 'actual joined tabs, not mocked profiles, appear on the home card');
  await second.bringToFront();
  await second.click('#drawerOpenBtn');
  await second.click('#leaveBtn');
  await second.waitForURL('**/index.html');
  await attendanceLobby.bringToFront();
  await waitFor(attendanceLobby, () => document.querySelector('.room-tile__people')?.getAttribute('aria-label') === '1 منضم الآن');
  assert.equal(await attendanceLobby.locator('.room-tile__avatar').count(), 1, 'leaving removes the live avatar without a reload');
  await first.context().browser().close();
  console.log('Browser message reactions and live lobby: two tabs, duplicate channels, switch/remove, history, deletion, real attendance and leave passed');

  /* Previously this left the whole room with zero handlers until refresh resolved. */
  const expired = await makePage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, {
    stallAuth: true,
    account: { access_token: 'expired', refresh_token: 'refresh', expires_at: 1,
      user: { id: 'account-test', name: 'حساب قديم', email: 'test@example.com' } }
  });
  await expired.goto(`${base}/room.html?local=1&id=BRTEST`);
  await expired.evaluate(() => { WT_CONFIG.auth.timeoutMs = 1800; });
  assert.equal(await expired.locator('#gate').isVisible(), false, 'account entry is automatic even during a stalled refresh');
  await expired.click('#drawerOpenBtn');
  assert.equal(await expired.evaluate(() => WTRoom.session.ready), false, 'drawer works while refresh is still pending');
  await expired.click('#drawerCloseBtn');
  await expired.click('#addVideoBtn');
  assert.ok(await expired.locator('#changeBar').isVisible());
  await expired.click('#cancelUrlBtn');
  await expired.click('#playlistBtn');
  await expired.click('#playlistCloseBtn');
  await waitReady(expired);
  assert.equal(await expired.evaluate(() => WTRoom.session.userId), 'account-test');
  await expired.evaluate(() => { WT_CONFIG.auth.timeoutMs = 100; });
  await expired.click('#drawerOpenBtn');
  await expired.click('#sbMeBtn');
  await expired.click('#meSignout');
  await expired.waitForURL('**/auth.html');
  assert.equal(await expired.evaluate(() => localStorage.getItem('wt:session')), null);
  console.log('Browser stalled auth: controls remain responsive, entry times out safely, sign-out works');

  const retry = await makePage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { owner: true });
  await enter(retry, '&host=1&v=' + encodeURIComponent(base + '/flaky.webm'));
  await waitFor(retry, () => WTRoom.player.state === WTPlayer.STATE.ERROR);
  assert.equal(await retry.locator('.player__overlay--loading .spinner').isVisible(), false);
  await retry.locator('.player__retry').click();
  await waitVideo(retry);
  assert.equal(await retry.locator('#player .player__frame').count(), 1);
  await retry.click('#centerPlayBtn');
  await waitFor(retry, () => WTRoom.player.isPlaying());
  console.log('Browser media failure: actionable error, retry, real playback and frame cleanup passed');

  assert.deepEqual(errors, [], 'no uncaught JavaScript errors');
  console.log('All browser regressions passed');
} finally {
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
  server.closeAllConnections(); mediaServer.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => mediaServer.close(resolve))]);
}
