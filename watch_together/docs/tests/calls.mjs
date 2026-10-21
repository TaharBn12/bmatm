/* =========================================================
   WatchTogether — اختبارات المكالمات الصوتية (calls.mjs)
   بلا اعتماديات وبلا شبكة: تتحقّق من منطق الحالات، وربط الواجهة،
   وسلامة SQL (RLS/الصلاحيات/عدم تخزين الصوت)، وغياب التسجيل.

   التشغيل:  node docs/tests/calls.mjs
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../..');
const read = (file) => fs.readFileSync(path.join(base, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(base, file));

let pass = 0;
let fail = 0;
function t(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  console.log('  ✗ FAIL:', name, detail == null ? '' : detail);
}

/* ==================== 1) آلة حالات المكالمة ==================== */
function loadState() {
  const sandbox = { console, Object, Set, Map, Number, String, Boolean, Date, Math };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('assets/js/call-state.js'), sandbox, { filename: 'call-state.js' });
  return sandbox.WTCallState;
}

const CS = loadState();
const S = CS.STATES;

t('call-state: يُصدّر آلة الحالات', !!CS && typeof CS.next === 'function');
t('call-state: idle → invite = ringing_out', CS.next(S.IDLE, 'invite') === S.RINGING_OUT);
t('call-state: idle → incoming = ringing_in', CS.next(S.IDLE, 'incoming') === S.RINGING_IN);
t('call-state: ringing_out → accept = connecting', CS.next(S.RINGING_OUT, 'accept') === S.CONNECTING);
t('call-state: ringing_in → reject = declined', CS.next(S.RINGING_IN, 'reject') === S.DECLINED);
t('call-state: ringing_out → timeout = missed', CS.next(S.RINGING_OUT, 'timeout') === S.MISSED);
t('call-state: connecting → connected = active', CS.next(S.CONNECTING, 'connected') === S.ACTIVE);
t('call-state: active → hangup = ended', CS.next(S.ACTIVE, 'hangup') === S.ENDED);
t('call-state: connecting → fail = failed', CS.next(S.CONNECTING, 'fail') === S.FAILED);
t('call-state: انتقال غير مسموح لا يغيّر الحالة', CS.next(S.RINGING_IN, 'connected') === S.RINGING_IN);
t('call-state: idle → hangup لا ينتج حالة وهمية', CS.next(S.IDLE, 'hangup') === S.IDLE);
t('call-state: الحالات النهائية تُعرَّف', [S.ENDED, S.MISSED, S.DECLINED, S.BUSY, S.FAILED].every(CS.isTerminal));
t('call-state: الرنين ليس نهائياً والجارية كذلك', !CS.isTerminal(S.RINGING_OUT) && CS.isLive(S.ACTIVE));
t('call-state: isRinging للحالتين فقط', CS.isRinging(S.RINGING_IN) && CS.isRinging(S.RINGING_OUT) && !CS.isRinging(S.ACTIVE));

t('call-state: منع الاتصال بغير صديق', (() => { const gate = CS.canStart({ friends: false }); return gate.ok === false && gate.reason.length > 5; })());
t('call-state: منع المحظور', CS.canStart({ blocked: true }).ok === false && /محظور/.test(CS.canStart({ blocked: true }).reason));
t('call-state: منع مكالمتين', CS.canStart({ hasActiveCall: true }).ok === false && /مكالمة/.test(CS.canStart({ hasActiveCall: true }).reason));
t('call-state: منع من أوقف الاستقبال', CS.canStart({ peerAllowsCalls: false }).ok === false && /استقبال/.test(CS.canStart({ peerAllowsCalls: false }).reason));
t('call-state: منع بلا HTTPS', CS.canStart({ secure: false }).ok === false && /HTTPS/.test(CS.canStart({ secure: false }).reason));
t('call-state: منع بلا دعم ميكروفون', CS.canStart({ hasMicApi: false }).ok === false && /الميكروفون/.test(CS.canStart({ hasMicApi: false }).reason));
t('call-state: يسمح في الحالة الطبيعية', CS.canStart({ friends: true, blocked: false, peerAllowsCalls: true, hasActiveCall: false, hasMicApi: true, secure: true }).ok === true);

const now = Date.parse('2026-01-01T10:00:00Z');
t('call-state: مهلة الرنين 45 ثانية', CS.ringExpired('2026-01-01T09:59:00Z', now, 45000) === true &&
  CS.ringExpired('2026-01-01T09:59:50Z', now, 45000) === false);
t('call-state: تاريخ غير صالح لا يُعدّ منتهياً', CS.ringExpired('not-a-date', now, 45000) === false);

t('call-state: مدة 0:05', CS.formatDuration(5000) === '00:05');
t('call-state: مدة 4:12', CS.formatDuration(252000) === '04:12');
t('call-state: مدة ساعة+', CS.formatDuration(3725000) === '1:02:05');
t('call-state: مدة سالبة = 00:00', CS.formatDuration(-5000) === '00:00');

t('سجل: مكالمة عادية بالمدة', CS.logLabel('hangup', 252000) === 'مكالمة صوتية · 04:12');
t('سجل: مكالمة فائتة', CS.logLabel('missed', 0) === 'مكالمة صوتية فائتة');
t('سجل: مهلة = فائتة', CS.logLabel('timeout', 0) === 'مكالمة صوتية فائتة');
t('سجل: مرفوضة', CS.logLabel('declined', 0) === 'مكالمة صوتية مرفوضة');
t('سجل: مشغول', CS.logLabel('busy', 0) === 'مكالمة صوتية — كان مشغولاً');
t('سجل: تعذّرت', CS.logLabel('failed', 0) === 'تعذّرت المكالمة الصوتية');
t('سجل: بلا مدة = «مكالمة صوتية»', CS.logLabel('hangup', 0) === 'مكالمة صوتية');

t('نص الحالة: الرنين يذكر الاسم', /أمين/.test(CS.statusText(S.RINGING_OUT, 'أمين')));
t('نص الحالة: الجارية تذكر الاسم', /مكالمة صوتية مع أمين/.test(CS.statusText(S.ACTIVE, 'أمين')));
t('سبب ICE فاشل = failed', CS.reasonFromIce('failed') === 'failed' && CS.reasonFromIce('connected') === 'hangup');

/* ==================== 2) ملف قاعدة البيانات ==================== */
const sql = read('docs/sql/09-calls.sql');
t('sql: ينشئ جدول المكالمات', /create table if not exists public\.wt_dm_calls/.test(sql));
t('sql: جدول إشارات مؤقت ومغلق', /create table if not exists public\.wt_call_signals/.test(sql));
t('sql: RLS مفعّل على الجدولين', /alter table public\.wt_dm_calls enable row level security/.test(sql) &&
  /alter table public\.wt_call_signals enable row level security/.test(sql));
t('sql: لا وصول مباشر لأي من الجدولين', /revoke all on public\.wt_dm_calls from public, anon, authenticated/.test(sql) &&
  /revoke all on public\.wt_call_signals from public, anon, authenticated/.test(sql));
t('sql: لا سياسات قراءة عامة تُضاف', !/create policy[\s\S]{0,200}wt_dm_calls/.test(sql));
t('sql: يوسّع أنواع الرسائل إلى call', /kind in \('text','room','call'\)/.test(sql));
t('sql: يضيف تفضيل استقبال المكالمات', /add column if not exists allow_calls/.test(sql) &&
  /wt_social_calls_pref/.test(sql));
t('sql: RPC البدء/القبول/الإنهاء/الحالة', ['call_start', 'call_answer', 'call_end', 'call_state'].every((name) =>
  new RegExp('function public\\.wt_social_' + name + '\\(').test(sql)));
t('sql: RPC الإشارات ذهاباً وإياباً', /function public\.wt_social_call_signal_put/.test(sql) &&
  /function public\.wt_social_call_signal_get/.test(sql));
t('sql: فحص المكالمات الواردة', /function public\.wt_social_call_incoming/.test(sql));
t('sql: منع المكالمات لغير الأصدقاء', /friends\(u, peer\)/.test(sql) && /رايز|raise exception 'المكالمات متاحة للأصدقاء/.test(sql));
t('sql: احترام الحظر', /blocked\(u, peer\)/.test(sql));
t('sql: احترام من أوقف الاستقبال', /allow_calls/.test(sql) && /أوقف استقبال المكالمات/.test(sql));
t('sql: مكالمة نشطة واحدة لكل مستخدم', /لديك مكالمة جارية بالفعل/.test(sql));
t('sql: حدّ معدّل بدء المكالمات', /consume\('call:'/.test(sql));
t('sql: حدّ معدّل الإشارات', /consume\('sig:'/.test(sql));
t('sql: حدّ حجم حمولة الإشارة', /octet_length\(p_payload::text\) > 65536/.test(sql));
t('sql: منع فيديو في النسخة الأولى', /media.*check \(media in \('audio','video'\)\)/.test(sql) &&
  /المكالمات الصوتية فقط متاحة/.test(sql));
t('sql: إغلاق ذرّي مرة واحدة (for update)', /from public\.wt_dm_calls where id = p_call for update/.test(sql));
t('sql: مهلة الرنين على الخادم', /interval '50 seconds'/.test(sql) && /call_expire/.test(sql));
t('sql: سطر السجل يُكتب داخل المحادثة', /insert into public\.wt_dm_messages[\s\S]{0,200}'call'/.test(sql));
t('sql: حذف الإشارات بعد الإغلاق', /delete from public\.wt_call_signals where call_id = c\.id/.test(sql));
t('sql: RPC متاحة للمسجّلين فقط', /grant execute on function public\.wt_social_call_start\(uuid,text\) to authenticated/.test(sql) &&
  /revoke all on function public\.wt_social_call_start\(uuid,text\) from public, anon/.test(sql));
t('sql: لا يمنح anon أي تنفيذ', !/grant execute[\s\S]{0,80}to anon/.test(sql));
t('sql: لا service_role ولا مفاتيح', !/service_role/i.test(sql) && !/eyJhbGciOi/.test(sql));
t('sql: ينظّف الإشارات القديمة', /wt_calls_cleanup/.test(sql) && /interval '10 minutes'/.test(sql));
t('sql: يعيد تحميل مخطط PostgREST', /notify pgrst, 'reload schema'/.test(sql));
t('sql: لا يحذف أي جدول قائم', !/drop table/i.test(sql));
t('sql: ملف موجود في المستودع', exists('docs/sql/09-calls.sql'));

/* ==================== 3) عميل المكالمة ==================== */
const calls = read('assets/js/calls.js');
t('calls.js: صياغة صحيحة (vm)', (() => { try { new vm.Script(calls); return true; } catch (e) { return false; } })());
t('calls.js: يطلب الصوت فقط بلا كاميرا', /video: false/.test(calls) && /getUserMedia/.test(calls));
t('calls.js: إعدادات صدى وضجيج تلقائية', /echoCancellation: true/.test(calls) && /noiseSuppression: true/.test(calls));
t('calls.js: يستخدم RTCPeerConnection', /new global\.RTCPeerConnection/.test(calls));
t('calls.js: يتبادل offer/answer/ice', /createOffer/.test(calls) && /createAnswer/.test(calls) && /addIceCandidate/.test(calls));
t('calls.js: الإشارات عبر RPC محمية فقط', /call_signal_put/.test(calls) && /call_signal_get/.test(calls));
t('calls.js: لا قنوات عامة تحمل SDP', !/\.channel\(|broadcast|postgres_changes/.test(calls));
t('calls.js: لا تسجيل ولا رفع صوت', !/MediaRecorder|startRecording|audio\/webm|storage\/v1/.test(calls));
t('calls.js: لا مفاتيح ولا أسرار', !/eyJhbGciOi|service_role/.test(calls));
t('calls.js: كتم عبر تعطيل المسار (بلا إعادة تفاوض)', /track\.enabled = !state\.muted/.test(calls));
t('calls.js: استئناف ICE عند الانقطاع', /restartIce/.test(calls));
t('calls.js: إنهاء عند إغلاق الصفحة', /beforeunload/.test(calls) && /'pagehide'|pagehide/.test(calls));
t('calls.js: قفل الشاشة أفضل جهد', /wakeLock/.test(calls));
t('calls.js: نغمة مولّدة محلياً بلا ملفات', /AudioContext/.test(calls) && !/\.mp3|\.wav|\.ogg/.test(calls));
t('calls.js: اهتزاز عند الرنين', /navigator\.vibrate/.test(calls));
t('calls.js: رسائل أخطاء الميكروفون بالعربية', /NotAllowedError/.test(calls) && /لم يُسمح باستخدام الميكروفون/.test(calls));
t('calls.js: لا يبدأ قبل إذن المستخدم (mic عند الضغط)', !/getUserMedia[\s\S]{0,80}DOMContentLoaded/.test(calls));
t('calls.js: واجهة وصولية (aria-live + aria-pressed)', /aria-live/.test(calls) && /aria-pressed/.test(calls));
t('calls.js: يتحقّق من HTTPS قبل البدء', /isSecureContext/.test(calls) && /المكالمات تحتاج اتصالاً آمناً|HTTPS/.test(calls));
t('calls.js: ينهي المكالمة عند تجاوز السقف', /maxCallMs/.test(calls));
t('calls.js: يبثّ حدث سجل المكالمة', /wt:call-logged/.test(calls));

/* ==================== 4) الربط في صفحة الرسائل ==================== */
const html = read('messages.html');
const messages = read('assets/js/messages.js');
const social = read('assets/js/social.js');
const config = read('assets/js/config.js');
const css = read('assets/css/call.css');

t('messages.html: زر مكالمة في رأس المحادثة', /id="chatCall"/.test(html) && /data-icon="phoneCall"/.test(html));
t('messages.html: زر المكالمة مخفيّ افتراضياً', /id="chatCall"[^>]*hidden/.test(html));
t('messages.html: يحمّل call.css', /assets\/css\/call\.css\?v=/.test(html));
t('messages.html: يحمّل call-state.js قبل calls.js', html.indexOf('call-state.js') > 0 &&
  html.indexOf('call-state.js') < html.indexOf('calls.js'));
t('messages.html: calls.js قبل messages.js', html.indexOf('assets/js/calls.js') < html.indexOf('assets/js/messages.js'));

t('messages.js: سطر سجل مكالمة في الفقاعة', /dm-call-log/.test(messages) && /m\.kind === 'call'/.test(messages));
t('messages.js: معاينة القائمة تعرض المكالمة', /m\.kind === 'call' \? '📞 '/.test(messages));
t('messages.js: يربط زر المكالمة', /chatCall'\)\.onclick/.test(messages) && /WTCalls\.start/.test(messages));
t('messages.js: يحدّث حالة الزر من الخادم', /WTCalls\.attach/.test(messages) && /WTCalls\.syncButton/.test(messages));
t('messages.js: يفحص المكالمات الواردة مع الدورات', /WTCalls\.pollIncoming/.test(messages));
t('messages.js: يعيد تحميل المحادثة بعد انتهاء المكالمة', /wt:call-logged/.test(messages));

t('social.js: الطرق الجديدة مسجّلة', ['calls_pref', 'call_start', 'call_answer', 'call_end', 'call_state', 'call_signal_put', 'call_signal_get', 'call_incoming']
  .every((m) => social.includes("'" + m + "'")));
t('config.js: قسم المكالمات مضبوط', /calls:\s*\{/.test(config) && /enabled: true/.test(config) &&
  /ringTimeoutMs: 45000/.test(config) && /maxCallMs/.test(config));
const configCode = config.replace(/\/\*[\s\S]*?\*\//g, '');
t('config.js: TURN قابل للضبط بلا مفاتيح مضمّنة', /turnFetchUrl: null/.test(configCode) && /turn: null/.test(configCode) &&
  !/credential:\s*'[^']+'/.test(configCode));
t('config.js: خادم STUN افتراضي', /stun:stun\.l\.google\.com:19302/.test(config));

t('call.css: شاشة الرنين وشريط المكالمة', /\.call-layer/.test(css) && /\.call-bar/.test(css) && /\.call-btn--accept/.test(css));
t('call.css: سطر سجل المكالمة منسّق', /\.dm-call-log/.test(css));
t('call.css: جوال من الأسفل', /max-width: 600px/.test(css) && /border-radius: 24px 24px 0 0/.test(css));
t('call.css: يحترم تقليل الحركة', /prefers-reduced-motion/.test(css) && /data-wt-motion="reduce"/.test(css));
t('call.css: لا استيراد خارجي', !/@import/.test(css));

/* ==================== 5) الخصوصية ==================== */
t('لا تُخزَّن الإشارات في قنوات عامة', !/channel\(['"]/.test(messages + calls));
t('لا رفع لأي ملف صوتي إلى التخزين', !/wt-dm-media|storage\/v1\/object/.test(calls));
t('الصوت لا يمر بخادمنا (P2P فقط)', !/\/rtc\/|media-server|sfu/i.test(calls));
t('سجل المكالمة نصّي بلا بيانات حساسة', (() => {
  const insert = sql.slice(sql.indexOf('insert into public.wt_dm_messages'), sql.indexOf('delete from public.wt_call_signals'));
  return !/sdp|candidate|ip/i.test(insert);
})());

console.log(`Calls: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
