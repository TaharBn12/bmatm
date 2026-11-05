package com.watchtogether;

import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * نقطة بحث في ديليموشن:  GET /api/search?q=كلمة&limit=18
 * ------------------------------------------------------------
 *  • المصدر الأول: yt-dlp بمستخرج البحث dailymotion:search
 *    (الرابط: https://www.dailymotion.com/search/<كلمة>/videos)
 *    مع --flat-playlist حتى تكون النتيجة سريعة (نداء بحث واحد).
 *  • المصدر الثاني (إن فشل الأول): واجهة ديليموشن العامة api.dailymotion.com
 *    بلا أي مفتاح.
 *  • التحسين: الأغلفة والمدة تُجلب في نداء واحد لكل المعرّفات
 *    (videos?ids=…) لأن البحث المسرّع لا يعيدها.
 *
 *  المتصفح لا يستطيع فعل هذا بنفسه (CORS)، ولا علاقة لهذه النقطة
 *  بتشغيل الفيديو: الرابط المباشر يأتي من /api/resolve بعملية yt-dlp.
 *
 *  الأمان: الكلمة تُنظّف ويُحدّ طولها، والرابطان المستخدمان ثابتان
 *  (dailymotion.com فقط) — لا يوجد تمرير لروابط من المستخدم.
 */
public final class SearchResolver {

    private static final int MAX_LIMIT = 24;
    private static final int DEFAULT_LIMIT = 18;
    private static final String SEARCH_HOST = "https://www.dailymotion.com/search/";
    private static final String API = "https://api.dailymotion.com/videos";
    private static final String FIELDS = "%(id)s\t%(title)s\t%(webpage_url)s\t%(duration)s";
    private static final String THUMB = "https://www.dailymotion.com/thumbnail/video/";

    private static final Semaphore SLOTS = new Semaphore(2);
    private static long windowStart = System.currentTimeMillis();
    private static int requests;

    private static synchronized boolean permit() {
        long now = System.currentTimeMillis();
        if (now - windowStart >= 60000) { windowStart = now; requests = 0; }
        return ++requests <= 20;
    }

    public static void handle(HttpExchange ex) throws IOException {
        int status = 200;
        Map<String, Object> result = new LinkedHashMap<>();
        boolean acquired = false;
        try {
            if (!"GET".equals(ex.getRequestMethod())) { status = 405; throw new IllegalArgumentException("استخدم GET"); }
            String origin = ex.getRequestHeaders().getFirst("Origin");
            if (origin != null && !sameOrigin(origin, ex.getRequestHeaders().getFirst("Host"))) {
                status = 403; throw new IllegalArgumentException("طلب من مصدر غير مسموح");
            }
            Map<String, String> query = params(ex.getRequestURI().getRawQuery());
            String term = clean(query.get("q"));
            if (term.length() < 2) { status = 400; throw new IllegalArgumentException("اكتب كلمة بحث من حرفين على الأقل"); }
            if (term.length() > 80) term = term.substring(0, 80);
            int limit = intParam(query.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);

            if (!permit()) { status = 429; throw new IllegalArgumentException("تم تجاوز حدّ البحث؛ انتظر قليلاً"); }
            acquired = SLOTS.tryAcquire();
            if (!acquired) { status = 429; throw new IllegalArgumentException("الخدمة مشغولة؛ أعد المحاولة بعد قليل"); }

            List<Map<String, Object>> items = viaYtDlp(term, limit);
            String source = "yt-dlp";
            if (items.isEmpty()) {
                items = viaApi(term, limit);
                source = "dailymotion-api";
            } else {
                enrich(items);
            }
            result.put("query", term);
            result.put("source", source);
            result.put("count", items.size());
            result.put("items", items);
        } catch (IllegalArgumentException e) {
            if (status == 200) status = 400;
            result.clear();
            result.put("error", e.getMessage());
            result.put("items", Collections.emptyList());
        } catch (Exception e) {
            status = 503;
            result.clear();
            result.put("error", "خدمة البحث غير متاحة؛ تأكد من تثبيت Python وyt-dlp على الخادم");
            result.put("items", Collections.emptyList());
        } finally {
            if (acquired) SLOTS.release();
        }
        byte[] bytes = Json.stringify(result).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    /* =========================================================
       1) البحث عبر yt-dlp (مستخرج dailymotion:search)
       ========================================================= */
    private static List<Map<String, Object>> viaYtDlp(String term, int limit) {
        Path out = null;
        Process p = null;
        try {
            String search = SEARCH_HOST + URLEncoder.encode(term, "UTF-8") + "/videos";
            out = Files.createTempFile("wt-search-", ".tsv");
            List<String> cmd = Py.ytDlp(Arrays.asList(
                "--ignore-config", "--no-warnings", "--socket-timeout", "10", "--retries", "1",
                "--use-extractors", "default,-generic", "--flat-playlist",
                "--playlist-end", String.valueOf(limit),
                "--print", FIELDS, "--", search));
            p = new ProcessBuilder(cmd).redirectOutput(out.toFile())
                                       .redirectError(ProcessBuilder.Redirect.DISCARD).start();
            if (!p.waitFor(30, TimeUnit.SECONDS)) return Collections.emptyList();
            if (p.exitValue() != 0 || Files.size(out) > 262144) return Collections.emptyList();
            List<Map<String, Object>> items = new ArrayList<>();
            for (String line : Files.readAllLines(out, StandardCharsets.UTF_8)) {
                Map<String, Object> item = fromRow(line);
                if (item != null) items.add(item);
                if (items.size() >= limit) break;
            }
            return dedupe(items);
        } catch (Exception e) {
            return Collections.emptyList();
        } finally {
            if (p != null && p.isAlive()) p.destroyForcibly();
            if (out != null) { try { Files.deleteIfExists(out); } catch (IOException ignored) { } }
        }
    }

    /** سطر من yt-dlp: id \t title \t url \t duration */
    private static Map<String, Object> fromRow(String line) {
        if (line == null) return null;
        String t = line.trim();
        if (t.isEmpty()) return null;
        String[] parts = t.split("\t", -1);
        String id = col(parts, 0);
        String title = col(parts, 1);
        String url = col(parts, 2);
        long duration = 0;
        try { duration = Long.parseLong(col(parts, 3)); } catch (Exception ignored) { }
        if (id.isEmpty()) return null;
        if (!isId(id)) return null;
        if (url.isEmpty() || "NA".equals(url)) url = "https://www.dailymotion.com/video/" + id;
        if (!url.startsWith("https://www.dailymotion.com/") && !url.startsWith("https://dailymotion.com/")
                && !url.startsWith("https://dai.ly/")) return null;
        if (title.isEmpty() || "NA".equals(title)) title = "";
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("title", title);
        m.put("url", url);
        m.put("thumb", THUMB + id);
        m.put("duration", duration);
        m.put("author", "");
        return m;
    }

    /* =========================================================
       2) تحسين النتائج: الأغلفة والمدة وصاحب الفيديو
       ========================================================= */
    private static void enrich(List<Map<String, Object>> items) {
        StringBuilder ids = new StringBuilder();
        for (Map<String, Object> item : items) {
            String id = String.valueOf(item.get("id"));
            if (isId(id)) { if (ids.length() > 0) ids.append(','); ids.append(id); }
        }
        if (ids.length() == 0) return;
        Object data = httpJson(API + "?ids=" + ids + "&limit=" + Math.min(100, items.size() + 4)
                + "&fields=id,title,thumbnail_720_url,duration,owner.username", 10);
        Map<String, Map<String, Object>> byId = index(data);
        if (byId.isEmpty()) {
            data = httpJson(API + "?ids=" + ids + "&limit=" + Math.min(100, items.size() + 4)
                    + "&fields=id,title,thumbnail_720_url,duration", 10);
            byId = index(data);
        }
        if (byId.isEmpty()) return;
        for (Map<String, Object> item : items) {
            Map<String, Object> extra = byId.get(String.valueOf(item.get("id")));
            if (extra == null) continue;
            String thumb = Json.str(extra, "thumbnail_720_url", "");
            if (thumb.startsWith("https://")) item.put("thumb", thumb);
            long duration = longOf(extra.get("duration"));
            if (duration > 0) item.put("duration", duration);
            String author = Json.str(extra, "owner.username", "");
            if (author.isEmpty()) {
                Map<String, Object> owner = Json.asMap(extra.get("owner"));
                author = Json.str(owner, "username", "");
            }
            if (!author.isEmpty()) item.put("author", author);
            if (String.valueOf(item.get("title")).isEmpty()) item.put("title", Json.str(extra, "title", ""));
        }
    }

    /* =========================================================
       3) المصدر البديل: واجهة ديليموشن العامة (بلا مفتاح)
       ========================================================= */
    private static List<Map<String, Object>> viaApi(String term, int limit) {
        String url = API + "?search=" + enc(term) + "&limit=" + limit + "&sort=relevance"
                + "&fields=id,title,thumbnail_720_url,duration,owner.username";
        Object data = httpJson(url, 10);
        if (data == null) {
            data = httpJson(API + "?search=" + enc(term) + "&limit=" + limit + "&sort=relevance"
                    + "&fields=id,title,thumbnail_720_url,duration", 10);
        }
        List<Map<String, Object>> out = new ArrayList<>();
        if (data == null) return out;
        Object rawList = (data instanceof Map) ? ((Map<?, ?>) data).get("list") : null;
        if (!(rawList instanceof List)) return out;
        for (Object entry : (List<?>) rawList) {
            Map<String, Object> v = Json.asMap(entry);
            if (v == null) continue;
            String id = Json.str(v, "id", "");
            if (!isId(id)) continue;
            String author = Json.str(v, "owner.username", "");
            if (author.isEmpty()) author = Json.str(Json.asMap(v.get("owner")), "username", "");
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", id);
            m.put("title", Json.str(v, "title", ""));
            m.put("url", "https://www.dailymotion.com/video/" + id);
            String thumb = Json.str(v, "thumbnail_720_url", "");
            m.put("thumb", thumb.startsWith("https://") ? thumb : THUMB + id);
            m.put("duration", longOf(v.get("duration")));
            m.put("author", author);
            out.add(m);
            if (out.size() >= limit) break;
        }
        return dedupe(out);
    }

    /* =========================================================
       أدوات مشتركة
       ========================================================= */
    private static Map<String, Map<String, Object>> index(Object data) {
        Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
        if (!(data instanceof Map)) return byId;
        Object rawList = ((Map<?, ?>) data).get("list");
        if (!(rawList instanceof List)) return byId;
        for (Object entry : (List<?>) rawList) {
            Map<String, Object> v = Json.asMap(entry);
            if (v == null) continue;
            String id = Json.str(v, "id", "");
            if (!id.isEmpty()) byId.put(id, v);
        }
        return byId;
    }

    private static Object httpJson(String url, int seconds) {
        HttpURLConnection c = null;
        try {
            /* URI أولاً: بانية URL المباشرة مهملة في Java 20+ */
            c = (HttpURLConnection) new java.net.URI(url).toURL().openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(seconds * 1000);
            c.setReadTimeout(seconds * 1000);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "WatchTogether/1.0 (+java-server)");
            int code = c.getResponseCode();
            if (code != 200) return null;
            java.io.InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            int total = 0;
            while ((n = in.read(chunk)) > 0) {
                total += n;
                if (total > 262144) break;
                buf.write(chunk, 0, n);
            }
            in.close();
            return Json.parse(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static List<Map<String, Object>> dedupe(List<Map<String, Object>> items) {
        Map<String, Map<String, Object>> seen = new LinkedHashMap<>();
        for (Map<String, Object> item : items) {
            String id = String.valueOf(item.get("id"));
            if (id.isEmpty() || "null".equals(id)) continue;
            if (!seen.containsKey(id)) seen.put(id, item);
        }
        return new ArrayList<>(seen.values());
    }

    private static String col(String[] parts, int i) {
        if (i >= parts.length) return "";
        String v = parts[i].trim();
        return "NA".equals(v) ? "" : v;
    }

    private static boolean isId(String id) {
        if (id == null) return false;
        String v = id.trim();
        if (v.isEmpty() || v.length() > 32) return false;
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
            if (!ok) return false;
        }
        return true;
    }

    private static long longOf(Object v) {
        if (v instanceof Number) return ((Number) v).longValue();
        try { return Long.parseLong(String.valueOf(v).trim()); } catch (Exception e) { return 0; }
    }

    /** كلمة بحث نظيفة: بلا محارف تحكّم، ومسافات موحّدة */
    private static String clean(String raw) {
        if (raw == null) return "";
        StringBuilder sb = new StringBuilder();
        for (char c : raw.toCharArray()) {
            if (c < 0x20 || c == 0x7F) c = ' ';
            sb.append(c);
        }
        return sb.toString().replace('\u00A0', ' ').replaceAll("\\s+", " ").trim();
    }

    private static String enc(String value) {
        try { return URLEncoder.encode(value, "UTF-8"); } catch (Exception e) { return value; }
    }

    private static int intParam(String raw, int def, int min, int max) {
        if (raw == null) return def;
        try {
            int v = Integer.parseInt(raw.trim());
            return Math.max(min, Math.min(max, v));
        } catch (Exception e) { return def; }
    }

    private static Map<String, String> params(String rawQuery) {
        Map<String, String> out = new LinkedHashMap<>();
        if (rawQuery == null || rawQuery.isEmpty()) return out;
        for (String pair : rawQuery.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String k = eq < 0 ? pair : pair.substring(0, eq);
            String v = eq < 0 ? "" : pair.substring(eq + 1);
            try {
                out.put(java.net.URLDecoder.decode(k, "UTF-8"), java.net.URLDecoder.decode(v, "UTF-8"));
            } catch (Exception e) {
                out.put(k, v);
            }
        }
        return out;
    }

    private static boolean sameOrigin(String origin, String host) {
        try {
            return java.util.Objects.equals(URI.create(origin).getRawAuthority(), host);
        } catch (Exception e) {
            return false;
        }
    }

    /** يُستخدم من السيرفر فقط — لا يوجد سبب لإنشاء نسخة من هذه الفئة */
    private SearchResolver() { }
}
