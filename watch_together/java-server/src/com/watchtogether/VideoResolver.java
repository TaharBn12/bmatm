package com.watchtogether;

import com.sun.net.httpserver.HttpExchange;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Bounded, same-origin extraction API. Requires python3 -m pip install yt-dlp. */
public final class VideoResolver {
    private static final Semaphore SLOTS = new Semaphore(2);
    private static final Set<String> HOSTS = new HashSet<>(Arrays.asList(
        "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
        "vimeo.com", "dailymotion.com", "dai.ly", "tiktok.com", "www.tiktok.com", "vm.tiktok.com",
        "twitter.com", "x.com", "facebook.com", "fb.watch", "instagram.com", "www.instagram.com"));

    /**
     * خرج yt-dlp بفواصل تبويب لا بصيغة JSON.
     * السبب: حقل ناقص يُطبع كـ NA (بدون تنصيص) فيفسد أي قالب JSON نبنيه،
     * فيصل المستخدم خطأ محلّل JSON غامض بدل سبب حقيقي. التبويب لا يُفسد.
     */
    private static final String FIELDS = "%(url)s\\t%(title)s\\t%(thumbnail)s";

    private static long windowStart = System.currentTimeMillis();
    private static int requests;
    private static synchronized boolean permit() {
        long now = System.currentTimeMillis();
        if (now - windowStart >= 60000) { windowStart = now; requests = 0; }
        return ++requests <= 12;
    }

    /**
     * يقرأ آخر سطر غير فارغ من خرج yt-dlp ويقسّمه على التبويب.
     * NA تعني حقلاً ناقصاً فنحوّلها إلى فراغ بدل أن نُفشل الطلب.
     */
    private static Map<String,Object> parseFields(String text) {
        if (text == null) return null;
        String last = "";
        for (String line : text.split("\\\\R")) {
            String t = line.trim();
            if (!t.isEmpty()) last = line;
        }
        if (last.isEmpty()) return null;
        String[] parts = last.split("\\t", -1);
        String mediaUrl = field(parts, 0);
        String title = field(parts, 1);
        String thumb = field(parts, 2);
        if (mediaUrl.isEmpty()) return null;
        Map<String,Object> m = new LinkedHashMap<>();
        m.put("url", mediaUrl);
        m.put("title", title);
        m.put("thumbnail", thumb);
        return m;
    }

    private static String field(String[] parts, int i) {
        if (i >= parts.length) return "";
        String v = parts[i].trim();
        return "NA".equals(v) ? "" : v;
    }

    /** قراءة آمنة لملف مؤقت (لا ترمي استثناءً، وتتسامح مع أي ترميز) */
    private static String read(Path file) {
        return Py.readUtf8(file);
    }

    /** ملخّص قصير للسجل — لا نُغرق الطرفية بخرج طويل */
    private static String forLog(String text) {
        String t = text == null ? "" : text.replaceAll("\\\\s+", " ").trim();
        return t.isEmpty() ? "(فارغ)" : (t.length() > 300 ? t.substring(0, 300) + "…" : t);
    }

    static void validate(String raw) throws Exception {
        URI u = new URI(raw);
        if (!"https".equals(u.getScheme()) || u.getUserInfo() != null || (u.getPort() != -1 && u.getPort() != 443))
            throw new IllegalArgumentException("استخدم رابط HTTPS عاماً دون بيانات دخول");
        String h = u.getHost();
        if (h == null) throw new IllegalArgumentException("رابط غير صالح");
        h = h.toLowerCase(Locale.ROOT);
        boolean allowed = false;
        for (String base : HOSTS) if (h.equals(base) || h.endsWith("." + base)) allowed = true;
        if (!allowed) throw new IllegalArgumentException("هذا الموقع غير مدعوم بالاستخراج حالياً؛ إضافة بطاقة لا تعني دعم استخراج الموقع");
        for (InetAddress a : InetAddress.getAllByName(h))
            if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress() || a.isMulticastAddress())
                throw new IllegalArgumentException("عنوان الشبكة غير مسموح");
    }

    static String formatForQuality(String quality) {
        switch (quality) {
            case "360": return "best[height<=360][ext=mp4][vcodec!=none][acodec!=none]/best[height<=360][vcodec!=none][acodec!=none]";
            case "720": return "best[height<=720][ext=mp4][vcodec!=none][acodec!=none]/best[height<=720][vcodec!=none][acodec!=none]";
            case "1080": return "best[height<=1080][ext=mp4][vcodec!=none][acodec!=none]/best[height<=1080][vcodec!=none][acodec!=none]";
            default: return "best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]";
        }
    }

    public static void handle(HttpExchange ex) throws IOException {
        int status = 200;
        Map<String,Object> result = new LinkedHashMap<>();
        Process p = null;
        Path output = null;
        Path errors = null;
        boolean acquired = false;
        try {
            if (Origins.preflight(ex, "POST, OPTIONS")) return;   /* طلب تمهيدي من نطاق آخر */
            if (!"POST".equals(ex.getRequestMethod())) { status = 405; throw new IllegalArgumentException("استخدم POST"); }
            if (!Origins.allowed(ex)) { status = 403; throw new IllegalArgumentException(Origins.denyMessage()); }
            byte[] body = ex.getRequestBody().readNBytes(8193);
            if (body.length > 8192) { status = 413; throw new IllegalArgumentException("الرابط طويل جداً"); }
            Map<String,Object> request;
            try { request = Json.parseObject(new String(body, StandardCharsets.UTF_8)); }
            catch (IllegalArgumentException e) { throw new IllegalArgumentException(Json.bodyError(e)); }
            if (request == null || !(request.get("url") instanceof String)) throw new IllegalArgumentException("الرابط مطلوب");
            String url = (String)request.get("url");
            boolean playlist = Boolean.TRUE.equals(request.get("playlist"));
            String quality = request.get("quality") instanceof String ? (String)request.get("quality") : "720";
            if (!permit()) { status = 429; throw new IllegalArgumentException("تم تجاوز حد الاستخراج؛ انتظر دقيقة"); }
            validate(url);
            acquired = SLOTS.tryAcquire();
            if (!acquired) { status = 429; throw new IllegalArgumentException("الخدمة مشغولة؛ أعد المحاولة بعد قليل"); }
            output = Files.createTempFile("wt-resolve-", ".tsv");
            errors = Files.createTempFile("wt-resolve-", ".err");   /* نحتفظ بخطأ yt-dlp للتشخيص */
            List<String> ytArgs = new ArrayList<>(Arrays.asList(
                "--ignore-config", "--skip-download", "--no-warnings", "--socket-timeout", "12", "--retries", "1",
                "--use-extractors", "default,-generic", "-f", formatForQuality(quality),
                "--print", FIELDS, "--", url));
            if (playlist) {
                ytArgs.add(ytArgs.indexOf("--") + 1, "--flat-playlist");
            } else {
                ytArgs.add(ytArgs.indexOf("--") + 1, "--no-playlist");
            }
            p = Py.process(ytArgs)
                .redirectOutput(output.toFile()).redirectError(errors.toFile()).start();
            if (!p.waitFor(40, TimeUnit.SECONDS)) { status = 504; throw new IllegalArgumentException("انتهت مهلة استخراج الرابط"); }
            if (p.exitValue() != 0 || Files.size(output) > 131072) {
                System.err.println("[resolve] فشل yt-dlp (الرمز " + p.exitValue() + ") للرابط: " + url);
                System.err.println("[resolve] رسالة yt-dlp: " + forLog(read(errors)));
                status = 422; throw new IllegalArgumentException("تعذّر استخراج فيديو عام قابل للتشغيل؛ قد يتطلب تسجيل دخول أو لا يكون مدعوماً. تأكد من تثبيت yt-dlp وتحديثه على الخادم");
            }
            String raw = read(output);
            if (playlist) {
                /* كل سطر غير فارغ: فيديو واحد من قائمة التشغيل المسطحة */
                List<Map<String,Object>> items = new ArrayList<>();
                for (String line : raw.split("\\R")) {
                    String t = line.trim();
                    if (t.isEmpty()) continue;
                    Map<String,Object> media = parseFields(t);
                    if (media == null || !(media.get("url") instanceof String) || !((String)media.get("url")).startsWith("https://")) continue;
                    items.add(media);
                }
                if (items.isEmpty()) {
                    status = 422; throw new IllegalArgumentException("لم يُعثر على فيديوهات قابلة للتشغيل في قائمة التشغيل");
                }
                result.put("playlist", true);
                result.put("items", items);
                result.put("count", items.size());
                result.put("sourceUrl", url);
            } else {
                Map<String,Object> media = parseFields(raw);
                if (media == null || !(media.get("url") instanceof String) || !((String)media.get("url")).startsWith("https://")) {
                    System.err.println("[resolve] yt-dlp لم يرجع رابطاً صالحاً: " + forLog(raw));
                    status = 422; throw new IllegalArgumentException("لم يُرجع الوسيط رابط فيديو آمناً");
                }
                result.putAll(media);
                result.put("sourceUrl", url);
            }
        } catch (IllegalArgumentException e) {
            if (status == 200) status = 400;
            result.clear(); result.put("error", e.getMessage());
        } catch (Exception e) {
            /* لا نخفي السبب: نطبعه في السجل ونرسل ملخّصه في الرد */
            System.err.println("[resolve] خطأ غير متوقّع في الاستخراج:");
            e.printStackTrace();
            status = 503;
            result.clear();
            result.put("error", "خدمة الاستخراج غير متاحة (" + e.getClass().getSimpleName() +
                (e.getMessage() == null ? "" : ": " + e.getMessage()) +
                ")؛ ثبّت Python وyt-dlp على خادم Java");
        } finally {
            if (p != null && p.isAlive()) p.destroyForcibly();
            if (output != null) Files.deleteIfExists(output);
            if (errors != null) Files.deleteIfExists(errors);
            if (acquired) SLOTS.release();
        }
        byte[] bytes = Json.stringify(result).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        Origins.apply(ex, "POST, OPTIONS");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }
}
