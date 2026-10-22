/* =========================================================
   WatchTogether — بيانات TURN المحلية (turn.local.js)
   ⚠️ هذا الملف يُقرأ من المتصفح: أي زائر لموقعك يستطيع رؤيته.

   البيانات أدناه من لوحة Metered (Open Relay). الحصّة المجانية 20 غ.ب/شهر
   على حسابك، وأي شخص ينسخ هذه القيم يمكنه استهلاكها.

   الترتيب من الأفضل إلى الأسرع:
   1) الإنتاج: انشر وسيط tools/turn/ وضع رابطه في config.js → calls.turnFetchUrl.
   2) تجربة خاصة: استعمل هذا الملف محلياً فقط (لا ترفعه).
   3) تجربة على الموقع المنشور: ارفعه كما هو — راقب Usage في لوحة Metered،
      وبدّل الاعتماد (Create credential جديد) عند أي شكّ.

   لإيقاف العمل به فوراً: اجعل السطر الأخير null، أو احذف الملف.
   ========================================================= */
(function () {
  'use strict';

  /* ✅ عدّل هذين السطرين فقط — اسم المستخدم موجود، وينقصك كلمة المرور */
  var USERNAME = 'c27c3311ba7a2107382e8d0e';
  var PASSWORD = 'RwGB7PD7G0WRuURM';     /* كلمة مرور Metered (Open Relay) */

  window.WT_TURN_LOCAL = [
    { urls: 'stun:stun.relay.metered.ca:80' },

    { urls: 'turn:global.relay.metered.ca:80',
      username: USERNAME, credential: PASSWORD },

    { urls: 'turn:global.relay.metered.ca:80?transport=tcp',
      username: USERNAME, credential: PASSWORD },

    { urls: 'turn:global.relay.metered.ca:443',
      username: USERNAME, credential: PASSWORD },

    { urls: 'turns:global.relay.metered.ca:443?transport=tcp',
      username: USERNAME, credential: PASSWORD }
  ];
})();
