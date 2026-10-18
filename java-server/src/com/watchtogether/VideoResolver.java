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
        "vimeo.com", "dailymotion.com", "dai.ly", "tiktok.com", "twitter.com", "x.com", "facebook.com", "fb.watch", "instagram.com"));

    private static long windowStart = System.currentTimeMillis();
    private static int requests;
    private static synchronized boolean permit() {
        long now = System.currentTimeMillis();
        if (now - windowStart >= 60000) { windowStart = now; requests = 0; }
        return ++requests <= 12;
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

    public static void handle(HttpExchange ex) throws IOException {
        int status = 200;
        Map<String,Object> result = new LinkedHashMap<>();
        Process p = null;
        Path output = null;
        boolean acquired = false;
        try {
            if (!"POST".equals(ex.getRequestMethod())) { status = 405; throw new IllegalArgumentException("استخدم POST"); }
            String origin = ex.getRequestHeaders().getFirst("Origin");
            if (origin != null && !Objects.equals(URI.create(origin).getRawAuthority(), ex.getRequestHeaders().getFirst("Host"))) {
                status = 403; throw new IllegalArgumentException("طلب من مصدر غير مسموح");
            }
            byte[] body = ex.getRequestBody().readNBytes(8193);
            if (body.length > 8192) { status = 413; throw new IllegalArgumentException("الرابط طويل جداً"); }
            Map<String,Object> request = Json.parseObject(new String(body, StandardCharsets.UTF_8));
            if (request == null || !(request.get("url") instanceof String)) throw new IllegalArgumentException("الرابط مطلوب");
            String url = (String)request.get("url");
            if (!permit()) { status = 429; throw new IllegalArgumentException("تم تجاوز حد الاستخراج؛ انتظر دقيقة"); }
            validate(url);
            acquired = SLOTS.tryAcquire();
            if (!acquired) { status = 429; throw new IllegalArgumentException("الخدمة مشغولة؛ أعد المحاولة بعد قليل"); }
            output = Files.createTempFile("wt-resolve-", ".json");
            p = new ProcessBuilder(System.getenv().getOrDefault("WT_PYTHON", "python3"), "-m", "yt_dlp",
                "--ignore-config", "--no-playlist", "--skip-download", "--no-warnings", "--socket-timeout", "12", "--retries", "1",
                "--use-extractors", "default,-generic", "-f", "best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]",
                "--print", "{\"url\":%(url)j,\"title\":%(title)j,\"thumbnail\":%(thumbnail)j}", "--", url)
                .redirectOutput(output.toFile()).redirectError(ProcessBuilder.Redirect.DISCARD).start();
            if (!p.waitFor(40, TimeUnit.SECONDS)) { status = 504; throw new IllegalArgumentException("انتهت مهلة استخراج الرابط"); }
            if (p.exitValue() != 0 || Files.size(output) > 131072) {
                status = 422; throw new IllegalArgumentException("تعذّر استخراج فيديو عام قابل للتشغيل؛ قد يتطلب تسجيل دخول أو لا يكون مدعوماً. تأكد من تثبيت yt-dlp وتحديثه على الخادم");
            }
            Map<String,Object> media = Json.parseObject(Files.readString(output).trim());
            if (media == null || !(media.get("url") instanceof String) || !((String)media.get("url")).startsWith("https://")) {
                status = 422; throw new IllegalArgumentException("لم يُرجع الوسيط رابط فيديو آمناً");
            }
            result.putAll(media);
            result.put("sourceUrl", url);
        } catch (IllegalArgumentException e) {
            if (status == 200) status = 400;
            result.clear(); result.put("error", e.getMessage());
        } catch (Exception e) {
            status = 503; result.clear(); result.put("error", "خدمة الاستخراج غير متاحة؛ ثبّت Python وyt-dlp على خادم Java");
        } finally {
            if (p != null && p.isAlive()) p.destroyForcibly();
            if (output != null) Files.deleteIfExists(output);
            if (acquired) SLOTS.release();
        }
        byte[] bytes = Json.stringify(result).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }
}
