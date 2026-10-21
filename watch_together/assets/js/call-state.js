/* =========================================================
   WatchTogether — آلة حالات المكالمة الصوتية (call-state.js)
   منطق نقي بلا DOM أو شبكة: قابل للاختبار وحده.
   ========================================================= */
(function (global) {
  'use strict';

  const STATES = Object.freeze({
    IDLE: 'idle',
    RINGING_OUT: 'ringing_out',
    RINGING_IN: 'ringing_in',
    CONNECTING: 'connecting',
    ACTIVE: 'active',
    MISSED: 'missed',
    DECLINED: 'declined',
    BUSY: 'busy',
    FAILED: 'failed',
    ENDED: 'ended'
  });

  const TERMINAL = new Set([STATES.MISSED, STATES.DECLINED, STATES.BUSY, STATES.FAILED, STATES.ENDED]);

  /* انتقالات مسموحة فقط — أي شيء غيرها يُهمَل (لا حالات وهمية) */
  const TRANSITIONS = Object.freeze({
    idle: { invite: 'ringing_out', incoming: 'ringing_in' },
    ringing_out: { accept: 'connecting', reject: 'declined', timeout: 'missed', fail: 'failed' },
    ringing_in: { accept: 'connecting', reject: 'declined', timeout: 'missed', fail: 'failed' },
    connecting: { connected: 'active', fail: 'failed', timeout: 'failed' },
    active: { hangup: 'ended', fail: 'failed' },
    missed: { reset: 'idle' },
    declined: { reset: 'idle' },
    busy: { reset: 'idle' },
    failed: { reset: 'idle' },
    ended: { reset: 'idle' }
  });

  function next(current, event) {
    const map = TRANSITIONS[current] || {};
    return map[event] || current;
  }

  function isTerminal(state) { return TERMINAL.has(state); }
  function isLive(state) { return state === STATES.RINGING_OUT || state === STATES.RINGING_IN || state === STATES.CONNECTING || state === STATES.ACTIVE; }
  function isRinging(state) { return state === STATES.RINGING_OUT || state === STATES.RINGING_IN; }

  /**
   * هل يمكن بدء مكالمة الآن؟
   * @param {{friends:boolean, blocked:boolean, peerAllowsCalls:boolean, hasActiveCall:boolean, hasMicApi:boolean, secure:boolean}} input
   * @returns {{ok:boolean, reason:string}}
   */
  function canStart(input) {
    const i = input || {};
    if (i.secure === false) return { ok: false, reason: 'المكالمات تعمل على HTTPS أو localhost فقط.' };
    if (i.hasMicApi === false) return { ok: false, reason: 'هذا المتصفح لا يدعم الميكروفون (WebRTC).' };
    if (i.hasActiveCall) return { ok: false, reason: 'لديك مكالمة جارية بالفعل.' };
    if (i.blocked) return { ok: false, reason: 'لا يمكن الاتصال بعضو محظور.' };
    if (i.friends === false) return { ok: false, reason: 'المكالمات متاحة للأصدقاء المقبولين فقط.' };
    if (i.peerAllowsCalls === false) return { ok: false, reason: 'هذا العضو أوقف استقبال المكالمات.' };
    return { ok: true, reason: '' };
  }

  /** هل انتهت مهلة الرنين؟ (بلا كذب: نعتمد على ساعة الخادم عند توفّرها) */
  function ringExpired(createdAt, now, timeoutMs) {
    const t = Date.parse(createdAt);
    if (!Number.isFinite(t)) return false;
    return (Number(now) || Date.now()) - t > (Number(timeoutMs) || 45000);
  }

  /** هل ما زالت الإشارات مسموحة لعمر المكالمة هذا؟ */
  function signalWindowOpen(ageMs) { return Number(ageMs) >= 0 && Number(ageMs) <= 3 * 3600 * 1000; }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }

  /** نص سجل المكالمة داخل المحادثة — نفس الصياغة في الواجهة وفي قاعدة البيانات */
  function logLabel(reason, durationMs) {
    switch (reason) {
      case 'missed':
      case 'timeout': return 'مكالمة صوتية فائتة';
      case 'declined': return 'مكالمة صوتية مرفوضة';
      case 'busy': return 'مكالمة صوتية — كان مشغولاً';
      case 'failed':
      case 'error': return 'تعذّرت المكالمة الصوتية';
      default: return formatDuration(durationMs) === '00:00' ? 'مكالمة صوتية' : 'مكالمة صوتية · ' + formatDuration(durationMs);
    }
  }

  /** وصف الحالة لقارئ الشاشة وللشريط العلوي */
  function statusText(state, peerName) {
    const name = peerName || 'الطرف الآخر';
    switch (state) {
      case 'ringing_out': return 'جارٍ الاتصال بـ' + name + '…';
      case 'ringing_in': return 'مكالمة من ' + name;
      case 'connecting': return 'يُفتح مسار الصوت…';
      case 'active': return 'مكالمة صوتية مع ' + name;
      case 'missed': return 'لم يرد ' + name;
      case 'declined': return 'رُفضت المكالمة';
      case 'busy': return name + ' في مكالمة أخرى';
      case 'failed': return 'تعذّر إتمام المكالمة';
      case 'ended': return 'انتهت المكالمة';
      default: return '';
    }
  }

  /** سبب إنهاء مفهوم من حدث الاتصال (نستخدمه في سجل المكالمة) */
  function reasonFromIce(iceState) {
    if (iceState === 'failed') return 'failed';
    if (iceState === 'disconnected') return 'failed';
    return 'hangup';
  }

  const CS = {
    STATES, TERMINAL, TRANSITIONS,
    next, isTerminal, isLive, isRinging, canStart, ringExpired,
    signalWindowOpen, formatDuration, logLabel, statusText, reasonFromIce
  };

  global.WTCallState = CS;
  if (typeof module !== 'undefined' && module.exports) module.exports = CS;
})(typeof window !== 'undefined' ? window : globalThis);
