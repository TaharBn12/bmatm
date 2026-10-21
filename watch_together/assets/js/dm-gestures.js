/* =========================================================
   WatchTogether — إيماءات المحادثة (dm-gestures.js)
   منطق نقي بلا DOM: قابل للاختبار وحده.
   • سحب الرسالة للردّ (يميناً أو يساراً) مع تجاهل التمرير العمودي.
   • تبديل التفاعل السريع ❤️.
   ========================================================= */
(function (global) {
  'use strict';

  const REACTIONS = Object.freeze(['❤️', '😮', '😂', '👍', '🔥']);
  const QUICK = '❤️';
  const SWIPE_THRESHOLD = 46;
  const SWIPE_MAX = 72;
  const VERTICAL_SLOP = 24;

  const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));

  /**
   * ماذا يفعل المستخدم بإصبعه؟
   * @returns {{active:boolean, vertical:boolean, trigger:boolean, offset:number, direction:number}}
   */
  function swipeIntent(dx, dy, threshold) {
    const t = Number(threshold) > 0 ? Number(threshold) : SWIPE_THRESHOLD;
    const x = Number(dx) || 0, y = Number(dy) || 0;
    const ax = Math.abs(x), ay = Math.abs(y);
    if (ay > VERTICAL_SLOP && ay > ax) return { active: false, vertical: true, trigger: false, offset: 0, direction: 0 };
    const direction = x === 0 ? 0 : x > 0 ? 1 : -1;
    return {
      active: ax > 8,
      vertical: false,
      trigger: ax >= t && ax > ay * 1.2,
      offset: clamp(ax, SWIPE_MAX) * direction,
      direction
    };
  }

  /** التفاعل التالي عند النقر المزدوج: نفس التفاعل يعني إزالته (لا تكرار). */
  function toggleReaction(current, wanted) {
    const next = reactionAllowed(wanted) ? wanted : QUICK;
    return current === next ? null : next;
  }

  function reactionAllowed(value) { return REACTIONS.indexOf(value) >= 0; }

  global.WTDMGestures = { REACTIONS, QUICK, SWIPE_THRESHOLD, SWIPE_MAX, swipeIntent, toggleReaction, reactionAllowed };
})(window);
