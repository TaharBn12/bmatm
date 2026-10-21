/* =========================================================
   WatchTogether — تفضيلات مبكرة (prefs.js)
   يُحمَّل في <head> قبل CSS لتفادي وميض اللون/الحركة.
   يقرأ wt:prefs ويكتب سمات <html> فقط — بلا أي DOM آخر.
   ========================================================= */
(function (global) {
  'use strict';
  var doc = global.document;
  var root = doc && doc.documentElement;
  if (!root) return;

  var prefs = {};
  try { prefs = JSON.parse(global.localStorage.getItem('wt:prefs') || '{}') || {}; }
  catch (e) { prefs = {}; }
  if (!prefs || typeof prefs !== 'object') prefs = {};

  var systemReduce = false;
  try {
    systemReduce = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { systemReduce = false; }

  var ACCENTS = ['gold', 'mint', 'rose', 'azure', 'violet'];
  var motion = prefs.motion === 'reduce' || prefs.motion === 'full' ? prefs.motion : 'auto';
  var accent = ACCENTS.indexOf(String(prefs.accent)) >= 0 ? String(prefs.accent) : 'gold';
  root.setAttribute('data-wt-motion',
    motion === 'reduce' || (motion === 'auto' && systemReduce) ? 'reduce' : 'full');

  if (accent !== 'gold') root.setAttribute('data-wt-accent', accent);
  if (prefs.contrast === 'high') root.setAttribute('data-wt-contrast', 'high');
  if (prefs.compact) root.setAttribute('data-wt-compact', '1');

  global.WTPrefs = {
    get: function () {
      return {
        accent: accent,
        motion: motion,
        contrast: prefs.contrast === 'high' ? 'high' : 'normal',
        compact: !!prefs.compact
      };
    }
  };
})(window);
