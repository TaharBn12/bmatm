package com.watchtogether;

import com.sun.net.httpserver.HttpExchange;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * نقطة اقتراحات للصيغ غير اليوتيوب: /api/suggest
 *
 * الفكرة: يوتيوب وحده يعطينا اقتراحات من المتصفح (قائمة الميكس RD).
 * أما ملف mp4 أو بث HLS أو تضمين من موقع آخر فلا مصدر له في المتصفح (CORS)،
 * لذا يستعين هذا الملف بـ yt-dlp المثبّت على السيرفر:
 *   1) إن كان الرابط سلسلة/قائمة (أكثر من مدخل) → الاقتراحات منها مباشرة
 *   2) وإن كان فيديو مفرداً → يستخرج عنوانه ثم يبحث به في يوتيوب
 *      (ytsearch:) فتكون النتيجة روابط يوتيوب قابلة للتشغيل في مشغّلنا
 *
 * الأمان: نفس ضوابط /api/resolve — https فقط، بلا بيانات دخول،
 * رفض العناوين الداخلية (SSRF)، حدّ requests/دقيقة، ومهلة لكل عملية.
 * المتطلب: python3 -m pip install yt-dlp على الخادم.
 */
public final class SuggestResolver {

    private static final Semaphore SLOTS = new Semaphore(2);
    private static long windowStart = System.currentTimeMillis();
    private static int requests;

    private static synchronized boolean permit() {
        long now = System.currentTimeMillis();
        if (now - windowStart >= 60000) { windowStart = now; requests = 0; }
        return ++requests <= 12;
    }

    /** نفس تحقّق /api/resolve، بلا قائمة مواقع: أي مضيف عام مقبول. */
    static void validate(String raw) throws Exception {
        URI u = new URI(raw);
        if (!"https".equals(u.getScheme()) || u.getUserInfo() != null || (u.getPort() != -1 && u.getPort() != 443))
            throw new IllegalArgumentException("استخدم رابط HTTPS عاماً دون بيانات دخول");
        String h = u.getHost();
        if (h == null) throw new IllegalArgumentException("رابط غير صالح");
        for (InetAddress a : InetAddress.getAllByName(h))
            if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() ||
                a.isSiteLocalAddress() || a.isMulticastAddress())
                throw new IllegalArgumentException("عنوان الشبكة غير مسموح");
    }

    private static final String FIELDS = "%(id)s	%(title)s	%(webpage_url)s	%(thumbnail)s";

    /** Generic extraction is limited to hosts used by our direct-upload providers. */
    private static boolean allowGenericMetadata(String raw) {
        try {
            URI uri = new URI(raw);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null ||
                (uri.getPort() != -1 && uri.getPort() != 443)) return false;
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            return host.equals("0x0.st") || host.equals("files.catbox.moe") || host.equals("litter.catbox.moe") ||
                host.equals("litterbox.catbox.moe") || host.equals("pixeldrain.com") || host.equals("tmpfiles.org") ||
                host.equals("oshi.at") || host.equals("file.io") || host.equals("www.file.io") ||
                host.equals("uguu.se") || host.equals("www.uguu.se") || host.equals("gofile.io") ||
                host.equals("www.gofile.io") || host.endsWith(".gofile.io") ||
                host.equals("cazwkhcbkzhnsluuafwz.supabase.co");
        } catch (Exception error) {
            return false;
        }
    }

    /** Runs yt-dlp with bounded output and a strict timeout. */
    private static List<String> runYtDlp(List<String> tail, int seconds) throws Exception {
        return runYtDlp(tail, seconds, false);
    }

    private static List<String> runYtDlp(List<String> tail, int seconds, boolean allowGeneric) throws Exception {
        Path out = Files.createTempFile("wt-suggest-", ".tsv");
        Process p = null;
        try {
            List<String> cmd = new ArrayList<>(Arrays.asList(
                "--ignore-config", "--no-warnings", "--socket-timeout", "8", "--retries", "0"));
            if (allowGeneric) cmd.addAll(Arrays.asList("--use-extractors", "default"));
            else cmd.addAll(Arrays.asList("--use-extractors", "default,-generic"));
            cmd.addAll(Arrays.asList("--flat-playlist", "--print", FIELDS));
            cmd.addAll(tail);
            /* Py.process يضمن ترميز UTF‑8 لخراج yt-dlp على ويندوز */
            p = Py.process(cmd).redirectOutput(out.toFile())
                               .redirectError(ProcessBuilder.Redirect.DISCARD).start();
            if (!p.waitFor(seconds, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                return Collections.emptyList();
            }
            if (p.exitValue() != 0 || Files.size(out) > 262144) return Collections.emptyList();
            List<String> lines = new ArrayList<>();
            /* قراءة متسامحة: أي بايت غير صالح يُستبدل ولا يُسقط الطلب */
            for (String line : new String(Files.readAllBytes(out), StandardCharsets.UTF_8).split("\\R")) {
                String t = line.trim();
                if (!t.isEmpty() && !t.startsWith("NA\\t")) lines.add(t);
            }
            return lines;
        } finally {
            if (p != null && p.isAlive()) p.destroyForcibly();
            try { Files.deleteIfExists(out); } catch (IOException ignored) { }
        }
    }

    private static Map<String, Object> parseRow(String line) {
        String[] parts = line.split("\\t", -1);
        String id = parts.length > 0 ? parts[0].trim() : "";
        String title = parts.length > 1 ? parts[1].trim() : "";
        String url = parts.length > 2 ? parts[2].trim() : "";
        String thumb = parts.length > 3 ? parts[3].trim() : "";
        if (title.isEmpty() || "NA".equals(title)) title = "";
        if ("NA".equals(url)) url = "";
        if ("NA".equals(thumb)) thumb = "";
        if (url.isEmpty()) return null;
        if (!url.startsWith("https://")) return null;         /* روابط تشغيل آمنة فقط */
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("title", title.isEmpty() ? url : title);
        m.put("url", url);
        m.put("thumb", thumb);
        return m;
    }

    public static void handle(HttpExchange ex) throws IOException {
        int status = 200;
        Map<String, Object> result = new LinkedHashMap<>();
        boolean acquired = false;
        try {
            if (Origins.preflight(ex, "POST, OPTIONS")) return;   /* طلب تمهيدي من نطاق آخر */
            if (!"POST".equals(ex.getRequestMethod())) { status = 405; throw new IllegalArgumentException("استخدم POST"); }
            if (!Origins.allowed(ex)) { status = 403; throw new IllegalArgumentException(Origins.denyMessage()); }
            byte[] body = ex.getRequestBody().readNBytes(8193);
            if (body.length > 8192) { status = 413; throw new IllegalArgumentException("الطلب طويل جداً"); }
            Map<String, Object> req;
            try { req = Json.parseObject(new String(body, StandardCharsets.UTF_8)); }
            catch (IllegalArgumentException e) { throw new IllegalArgumentException(Json.bodyError(e)); }
            if (req == null || !(req.get("url") instanceof String)) throw new IllegalArgumentException("الرابط مطلوب");
            String url = ((String) req.get("url")).trim();

            int limit = 12;
            Object l = req.get("limit");
            if (l instanceof Number) limit = Math.max(1, Math.min(24, ((Number) l).intValue()));

            if (!permit()) { status = 429; throw new IllegalArgumentException("تم تجاوز حد الطلبات؛ انتظر دقيقة"); }
            validate(url);
            acquired = SLOTS.tryAcquire();
            if (!acquired) { status = 429; throw new IllegalArgumentException("الخدمة مشغولة؛ أعد المحاولة بعد قليل"); }

            if (Boolean.TRUE.equals(req.get("metadataOnly"))) {
                List<String> metadataRows = runYtDlp(
                    Arrays.asList("--no-playlist", "--skip-download", "--", url), 14, allowGenericMetadata(url));
                Map<String, Object> metadata = metadataRows.isEmpty() ? null : parseRow(metadataRows.get(0));
                result.put("metadata", metadata);
                result.put("items", Collections.emptyList());
                result.put("source", metadata == null ? "none" : "yt-dlp");
            } else {
                List<Map<String, Object>> items = new ArrayList<>();
                String source = "none";

                /* 1) سلسلة/قائمة: أكثر من مدخل في الرابط نفسه */
                List<String> rows = runYtDlp(Arrays.asList("--playlist-end", String.valueOf(limit + 4), "--", url), 22);
                for (String row : rows) {
                    Map<String, Object> m = parseRow(row);
                    if (m == null) continue;
                    if (sameVideo(url, (String) m.get("url"))) continue;   /* لا نقترح الفيديو الحالي */
                    m.put("source", "series");
                    items.add(m);
                    if (items.size() >= limit) break;
                }
                if (!items.isEmpty()) source = "series";

                /* 2) فيديو مفرد: العنوان ← بحث يوتيوب (نتائج قابلة للتشغيل عندنا) */
                if (items.isEmpty()) {
                    String title = rows.size() == 1 ? titleOf(rows.get(0)) : "";
                    if (title.isEmpty()) {
                        List<String> one = runYtDlp(Arrays.asList("--no-playlist", "--", url), 18);
                        if (!one.isEmpty()) title = titleOf(one.get(0));
                    }
                    if (!title.isEmpty()) {
                        String q = "ytsearch" + (limit + 3) + ":" + cleanQuery(title);
                        for (String row : runYtDlp(Arrays.asList("--playlist-end", String.valueOf(limit + 3), "--", q), 22)) {
                            Map<String, Object> m = parseRow(row);
                            if (m == null) continue;
                            m.put("source", "search");
                            items.add(m);
                            if (items.size() >= limit) break;
                        }
                        if (!items.isEmpty()) source = "search";
                    }
                }

                result.put("items", items);
                result.put("source", source);
            }
        } catch (IllegalArgumentException e) {
            if (status == 200) status = 400;
            result.clear();
            result.put("error", e.getMessage());
            result.put("items", Collections.emptyList());
        } catch (Exception e) {
            status = 503;
            result.clear();
            result.put("error", "خدمة الاقتراحات غير متاحة؛ ثبّت Python وyt-dlp على الخادم");
            result.put("items", Collections.emptyList());
        } finally {
            if (acquired) SLOTS.release();
        }
        byte[] bytes = Json.stringify(result).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        Origins.apply(ex, "POST, OPTIONS");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    private static String titleOf(String row) {
        String[] p = row.split("\\t", -1);
        String t = p.length > 1 ? p[1].trim() : "";
        return (t.isEmpty() || "NA".equals(t)) ? "" : t;
    }

    /** يطابق الفيديو الحالي: نفس الرابط أو نفس معرّف يوتيوب. */
    private static boolean sameVideo(String a, String b) {
        if (a.equals(b)) return true;
        String ia = ytId(a), ib = ytId(b);
        return ia != null && ia.equals(ib);
    }

    private static String ytId(String s) {
        java.util.regex.Matcher m =
            java.util.regex.Pattern.compile("(?:[?&]v=|youtu\\.be/|shorts/|live/|embed/)([a-zA-Z0-9_-]{11})")
                .matcher(s);
        return m.find() ? m.group(1) : null;
    }

    /** استعلام آمن لـ ytsearch: سطر واحد، بدون محارف تتحكّم بالمُستخرِج. */
    private static String cleanQuery(String title) {
        String q = title.replaceAll("[\\r\\n\\t]+", " ").trim();
        if (q.length() > 100) q = q.substring(0, 100);
        return q;
    }
}
