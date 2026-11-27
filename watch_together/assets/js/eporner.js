/* Eporner API v2 client. All upstream operations use the same-origin Java proxy. */
(function (global) {
  'use strict';

  const ACK_KEY = 'wt:search:adult-confirmed';
  const PATHS = Object.freeze({
    search: 'video/search/',
    video: 'video/id/',
    removed: 'video/removed/',
    status: 'video/status/',
    categories: 'categories/',
    pornstars: 'pornstars/',
    oembed: 'oembed/',
    openapi: 'openapi/'
  });

  function hasAdultConfirmation() {
    try { return global.sessionStorage.getItem(ACK_KEY) === 'yes'; }
    catch (_) { return false; }
  }

  function endpoint(path) {
    const relative = 'api/eporner/' + path;
    return global.WTServer && typeof global.WTServer.api === 'function'
      ? global.WTServer.api(relative) : relative;
  }

  function queryString(params) {
    const query = new URLSearchParams();
    Object.keys(params || {}).forEach(key => {
      if (key === 'adult_confirmed') return;
      const value = params[key];
      if (value === undefined || value === null || value === '') return;
      query.set(key, Array.isArray(value) ? value.join(',') : String(value));
    });
    query.set('adult_confirmed', '1');
    return query.toString();
  }

  async function request(operation, params) {
    const path = PATHS[operation];
    if (!path) throw new Error('عملية Eporner غير معروفة');
    if (!hasAdultConfirmation()) throw new Error('تأكيد 18+ مطلوب قبل استخدام Eporner');
    const query = queryString(params);
    const url = endpoint(path) + (query ? '?' + query : '');
    const format = params && params.format;
    const response = await global.fetch(url, {
      headers: { Accept: format === 'xml' ? 'application/xml, text/xml' : 'application/json' },
      cache: 'no-store'
    });
    let text = '';
    try { text = await response.text(); } catch (_) { }
    const contentType = response.headers && response.headers.get
      ? String(response.headers.get('content-type') || '').toLowerCase() : '';
    const retryAfter = response.headers && response.headers.get
      ? String(response.headers.get('retry-after') || '') : '';
    let data = text;
    if (/json/.test(contentType) || (!contentType && /^[\s]*[\[{]/.test(text))) {
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    }
    if (!response.ok) {
      const message = data && typeof data === 'object'
        ? data.detail || data.error || data.title || ('HTTP ' + response.status)
        : String(data || ('HTTP ' + response.status));
      const error = new Error(message);
      error.status = response.status;
      error.serverDown = response.status >= 500;
      error.retryAfter = retryAfter;
      throw error;
    }
    if (/json/.test(contentType) && data === null && text) throw new Error('ردّ Eporner JSON غير صالح');
    return data;
  }

  global.WTEpornerApi = Object.freeze({
    operations: PATHS,
    hasAdultConfirmation,
    run: request,
    search: params => request('search', params),
    video: params => request('video', params),
    removed: params => request('removed', params),
    status: params => request('status', params),
    categories: params => request('categories', params),
    pornstars: params => request('pornstars', params),
    oembed: params => request('oembed', params),
    openapi: params => request('openapi', params)
  });
})(window);
