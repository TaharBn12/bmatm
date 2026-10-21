/* =========================================================
   WatchTogether — أدوات TURN المشتركة (tools/turn/lib.mjs)
   منطق نقي: تطبيع صيغ الاستجابة، تصنيف العناوين، فحص انتهاء
   الاعتماد، وطلب STUN خام (بلا اعتماديات).
   ========================================================= */

/** يقبل ثلاث صيغ ويعيد مصفوفة موحّدة: [{urls, username, credential}] */
export function normalizeServers(payload) {
  const entries = Array.isArray(payload) ? payload
    : Array.isArray(payload && payload.iceServers) ? payload.iceServers
    : payload && payload.urls ? [payload] : [];
  const list = [];
  const push = (urls, entry) => {
    if (!urls) return;
    list.push({
      urls,
      username: String(entry.username || ''),
      credential: String(entry.credential || entry.password || '')
    });
  };
  for (const entry of entries) {
    if (!entry) continue;
    const urls = entry.urls || entry.url;
    if (!urls) continue;
    push(urls, entry);
  }
  return list;
}

/** تفكيك العناوين إلى قوائم حسب البروتوكول */
export function classify(servers) {
  const out = { turn: [], turns: [], stun: [], other: [] };
  for (const server of servers || []) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const raw of urls) {
      const url = String(raw || '');
      if (/^turns:/i.test(url)) out.turns.push(url);
      else if (/^turn:/i.test(url)) out.turn.push(url);
      else if (/^stun:/i.test(url)) out.stun.push(url);
      else out.other.push(url);
    }
  }
  return out;
}

/** هل توجد بيانات اعتماد لكل عنوان turn/turns؟ */
export function validateCredentials(servers) {
  const problems = [];
  for (const server of servers || []) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const needsAuth = urls.some((url) => /^turns?:/i.test(String(url)));
    if (needsAuth && (!server.username || !server.credential)) {
      problems.push('عنوان TURN بلا اسم مستخدم أو كلمة مرور: ' + urls.join(', '));
    }
  }
  return problems;
}

/**
 * بعض المزوّدين يرسلون username بصيغة "<انتهاء>[:اسم]" (نمط coturn REST).
 * نستخرج وقت الانتهاء إن وُجد.
 * @returns {{expiresAt:number|null, ttlSeconds:number|null}}
 */
export function usernameExpiry(username, now) {
  const match = String(username || '').match(/^(\d{10})(?::|$)/);
  if (!match) return { expiresAt: null, ttlSeconds: null };
  const expiresAt = Number(match[1]) * 1000;
  return { expiresAt, ttlSeconds: Math.round((expiresAt - (now == null ? Date.now() : now)) / 1000) };
}

/** استخراج host/port من عنوان turn:/turns:/stun: */
export function hostPort(url) {
  const raw = String(url || '').replace(/^(turns?|stun):/i, '');
  const [hostPart, query] = raw.split('?');
  const [host, port] = hostPart.split(':');
  const transport = /transport=tcp/i.test(query || '') ? 'tcp' : 'udp';
  return { host: host || '', port: Number(port) || (String(url).toLowerCase().startsWith('turns:') ? 5349 : 3478), transport };
}

/** بناء طلب STUN Binding (RFC 5389) — 20 بايت */
export function buildStunBindingRequest(transactionId) {
  const buffer = Buffer.alloc(20);
  buffer.writeUInt16BE(0x0001, 0);          /* Binding Request */
  buffer.writeUInt16BE(0x0000, 2);          /* Length */
  buffer.writeUInt32BE(0x2112a442, 4);      /* Magic Cookie */
  const tx = transactionId || randomTransaction();
  tx.copy(buffer, 8);
  return buffer;
}

export function randomTransaction() {
  const bytes = Buffer.alloc(12);
  for (let i = 0; i < 12; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** هل الاستجابة STUN Binding Success؟ */
export function isStunSuccess(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 20 && buffer.readUInt16BE(0) === 0x0101;
}
