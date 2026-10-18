/* Phone photo editor: signature check → decode → pan/zoom/rotate → fresh 512px WebP.
   No original bytes, EXIF, GPS, external image URLs or third-party image services are uploaded. */
(function (global) {
  'use strict';
  const C = global.WTSocialUI, S = global.WTSocial;
  function signature(bytes) {
    if (bytes.length < 12) return '';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
    if ([137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b)) return 'png';
    const word = (a,b) => String.fromCharCode(...bytes.slice(a,b));
    if (word(0,4) === 'RIFF' && word(8,12) === 'WEBP') return 'webp';
    if (word(4,8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1|avif/.test(word(8,Math.min(bytes.length,64)))) return 'heif';
    return '';
  }
  function create(options) {
    const $ = C.$, dialog = $('photoDialog'), canvas = $('photoCanvas');
    let ctx = null;
    try { ctx = canvas.getContext('2d', { alpha: false }); } catch (_) { /* fail only the photo editor, never the whole profile */ }
    let image, url, generation = 0, zoom = 1, angle = 0, x = 0, y = 0, busy = false, drag;
    function metrics() {
      if (!image) return { scale: 1, mx: 0, my: 0 };
      const quarter = angle % 180 !== 0, w = quarter ? image.naturalHeight : image.naturalWidth, h = quarter ? image.naturalWidth : image.naturalHeight;
      const scale = Math.max(512 / w,512 / h) * zoom;
      return { scale, mx: Math.max(0,(w * scale - 512) / 2), my: Math.max(0,(h * scale - 512) / 2) };
    }
    function draw() {
      if (!image || !ctx) return;
      const m = metrics(); x = Math.max(-m.mx,Math.min(m.mx,x)); y = Math.max(-m.my,Math.min(m.my,y));
      ctx.fillStyle = '#172018'; ctx.fillRect(0,0,512,512);
      ctx.save(); ctx.translate(256 + x,256 + y); ctx.rotate(angle * Math.PI / 180);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image,-image.naturalWidth * m.scale / 2,-image.naturalHeight * m.scale / 2,image.naturalWidth * m.scale,image.naturalHeight * m.scale);
      ctx.restore();
    }
    function cleanup() { generation++; if (url) URL.revokeObjectURL(url); url = null; if (image) image.src = ''; image = null; drag = null; if (ctx) ctx.clearRect(0,0,512,512); }
    function close() { if (busy) return; dialog.close(); cleanup(); }
    async function open(file) {
      const ticket = ++generation;
      C.error('profileError', null); C.error('photoError', null);
      try {
        if (!ctx) throw new Error('محرّر الصور غير مدعوم في هذا المتصفح. جرّب متصفحًا أحدث.');
        if (!file || file.size > 20 * 1024 * 1024 || file.size < 12) throw new Error('اختر صورة لا تتجاوز 20 ميغابايت.');
        const type = signature(new Uint8Array(await file.slice(0,64).arrayBuffer()));
        if (!type) throw new Error('اختر صورة JPEG أو PNG أو WebP، وليس ملف SVG أو ملفًا آخر.');
        if (ticket !== generation) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(file);
        zoom = 1; angle = 0; x = 0; y = 0; $('photoZoom').value = '1';
        dialog.showModal(); C.busy($('photoSave'), true, 'نجهّز الصورة…');
        let timer;
        const decoded = new Image(); decoded.decoding = 'async';
        try {
          await Promise.race([
            new Promise((resolve,reject) => { decoded.onload = resolve; decoded.onerror = () => reject(new Error(type === 'heif' ? 'متصفحك لا يدعم هذه الصورة HEIC؛ اختر JPEG من إعدادات الهاتف أو حوّلها أولاً.' : 'تعذّر قراءة الصورة؛ جرّب صورة أخرى.')); decoded.src = url; }),
            new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('تعذّر تجهيز الصورة في الوقت المحدد. جرّب نسخة أصغر أو JPEG.')),6000); })
          ]);
        } finally { clearTimeout(timer); }
        if (ticket !== generation) { decoded.src = ''; return; }
        if (!decoded.naturalWidth || !decoded.naturalHeight || decoded.naturalWidth * decoded.naturalHeight > 50000000) throw new Error('الصورة كبيرة جدًا؛ اختر نسخة أقل من 50 ميغابكسل.');
        image = decoded; draw(); canvas.focus();
      } catch (err) {
        if (ticket !== generation) return;
        C.error(dialog.open ? 'photoError' : 'profileError', err);
      } finally {
        if (ticket === generation) { C.busy($('photoSave'), false); $('photoSave').disabled = !image; }
      }
    }
    options.button.addEventListener('click', () => options.input.click());
    options.input.addEventListener('change', () => { const file = options.input.files[0]; options.input.value = ''; if (file) open(file); });
    $('closePhoto').onclick = close; $('photoCancel').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (image || url) cleanup(); });
    $('photoZoom').oninput = event => { if (busy) return; zoom = Number(event.target.value); draw(); };
    $('rotatePhoto').onclick = () => { if (busy) return; angle = (angle + 90) % 360; x = 0; y = 0; draw(); };
    canvas.addEventListener('pointerdown', event => { if (!image || busy) return; drag = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener('pointermove', event => { if (!drag || !image || busy) return; const scale = 512 / canvas.getBoundingClientRect().width; x += (event.clientX - drag.x) * scale; y += (event.clientY - drag.y) * scale; drag = { x: event.clientX, y: event.clientY }; draw(); });
    const stopDrag = () => { drag = null; }; canvas.addEventListener('pointerup', stopDrag); canvas.addEventListener('pointercancel', stopDrag); canvas.addEventListener('lostpointercapture', stopDrag);
    canvas.addEventListener('keydown', event => {
      if (!image || busy || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const step = event.shiftKey ? 1 : 10;
      x += event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      y += event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0; draw();
    });
    $('photoSave').onclick = async () => {
      if (!image || busy) return;
      busy = true; C.error('photoError', null); C.busy($('photoSave'), true, 'جارٍ حفظ الصورة…');
      ['closePhoto','photoCancel','rotatePhoto','photoZoom'].forEach(id => { $(id).disabled = true; });
      try {
        let blob;
        for (const quality of [.88,.72,.5]) {
          blob = await new Promise(resolve => canvas.toBlob(resolve,'image/webp',quality));
          if (!blob || blob.type !== 'image/webp') throw new Error('متصفحك لا يصدّر WebP. حدّث المتصفح للمحافظة على خصوصية الصورة.');
          if (blob.size <= 262144) break;
        }
        const profile = await S.uploadAvatar(blob);
        if (options.onSaved) await options.onSaved(profile);
        busy = false; close();
        global.WTUtil.toast('تم تحديث صورتك الشخصية', 'success');
      } catch (err) { C.error('photoError', err); }
      finally {
        busy = false; C.busy($('photoSave'), false);
        ['closePhoto','photoCancel','rotatePhoto','photoZoom'].forEach(id => { $(id).disabled = false; });
      }
    };
    return { open, close };
  }
  global.WTPhotoEditor = { create, signature };
})(window);
