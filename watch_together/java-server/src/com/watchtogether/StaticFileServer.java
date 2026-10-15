package com.watchtogether;

import com.sun.net.httpserver.HttpExchange;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * خادم ملفات ثابتة بسيط وآمن (بدون مكتبات خارجية).
 * يقدّم صفحات الموقع من المجلد الأب لمجلد java-server (أي مجلد watch_together نفسه)،
 * فتعمل نفس الصفحات على أي استضافة تدعم Java: Tomcat / Jetty / VPS / معاينة Arena.
 */
public final class StaticFileServer {

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("htm",  "text/html; charset=utf-8");
        MIME.put("css",  "text/css; charset=utf-8");
        MIME.put("js",   "application/javascript; charset=utf-8");
        MIME.put("mjs",  "application/javascript; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("map",  "application/json; charset=utf-8");
        MIME.put("svg",  "image/svg+xml");
        MIME.put("png",  "image/png");
        MIME.put("jpg",  "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif",  "image/gif");
        MIME.put("webp", "image/webp");
        MIME.put("ico",  "image/x-icon");
        MIME.put("woff", "font/woff");
        MIME.put("woff2","font/woff2");
        MIME.put("ttf",  "font/ttf");
        MIME.put("mp4",  "video/mp4");
        MIME.put("webm", "video/webm");
        MIME.put("m4s",  "video/iso.segment");
        MIME.put("ts",   "video/mp2t");
        MIME.put("m3u8", "application/vnd.apple.mpegurl");
        MIME.put("txt",  "text/plain; charset=utf-8");
        MIME.put("md",   "text/markdown; charset=utf-8");
        MIME.put("sql",  "text/plain; charset=utf-8");
        MIME.put("pdf",  "application/pdf");
    }

    private final File root;

    public StaticFileServer(File root) {
        this.root = root;
    }

    public File getRoot() { return root; }

    public void handle(HttpExchange ex) throws IOException {
        try {
            String path = ex.getRequestURI().getPath();
            if ("HEAD".equalsIgnoreCase(ex.getRequestMethod())) { ex.sendResponseHeaders(204, -1); return; }

            /* نقطة فحص صحية */
            if (path.equals("/healthz") || path.equals("/api/health")) {
                byte[] body = "{\"status\":\"ok\"}".getBytes(StandardCharsets.UTF_8);
                ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
                ex.getResponseHeaders().set("Cache-Control", "no-store");
                ex.sendResponseHeaders(200, body.length);
                try (OutputStream os = ex.getResponseBody()) { os.write(body); }
                return;
            }

            File file = resolve(path);
            if (file == null || !file.isFile()) {
                /* SPA-ish: أي مسار غير معروف يعيد الصفحة الرئيسية */
                File index = new File(root, "index.html");
                if (path.startsWith("/assets/") || !index.isFile()) { send404(ex, path); return; }
                file = index;
            }
            sendFile(ex, file);
        } finally {
            ex.close();
        }
    }

    /** يمنع تجاوز المجلد الجذر (../) ويعيد الملف المطلوب أو null */
    private File resolve(String rawPath) throws IOException {
        String decoded = URLDecoder.decode(rawPath, "UTF-8").replace('\\', '/');
        if (decoded.contains("\0")) return null;

        StringBuilder clean = new StringBuilder();
        for (String part : decoded.split("/")) {
            if (part.isEmpty() || part.equals(".")) continue;
            if (part.equals("..")) return null;              // رفض صريح
            clean.append('/').append(part);
        }
        if (clean.length() == 0) return new File(root, "index.html");

        File candidate = new File(root, clean.substring(1));
        String rootPath = root.getCanonicalPath();
        String filePath = candidate.getCanonicalPath();
        if (!filePath.equals(rootPath) && !filePath.startsWith(rootPath + File.separator)) return null;
        return candidate;
    }

    private void sendFile(HttpExchange ex, File file) throws IOException {
        String mime = mimeFor(file.getName());
        long len = file.length();
        long age = System.currentTimeMillis() - file.lastModified();

        ex.getResponseHeaders().set("Content-Type", mime);
        ex.getResponseHeaders().set("Accept-Ranges", "bytes");
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        /* الملفات الثابتة للمكتبات تُخزَّن طويلاً، صفحات HTML تُعاد دائماً */
        if (mime.startsWith("text/html") || mime.equals("application/json; charset=utf-8")) {
            ex.getResponseHeaders().set("Cache-Control", "no-cache");
        } else {
            ex.getResponseHeaders().set("Cache-Control", age < 60_000 ? "no-cache" : "public, max-age=3600");
        }

        /* دعم Range (مهم لملفات الفيديو) */
        String range = ex.getRequestHeaders().getFirst("Range");
        long start = 0, end = len - 1;
        boolean partial = false;
        if (range != null && range.startsWith("bytes=") && mime.startsWith("video")) {
            try {
                String spec = range.substring(6).split(",")[0].trim();
                String[] p = spec.split("-", -1);
                if (!p[0].isEmpty()) start = Long.parseLong(p[0]);
                if (p.length > 1 && !p[1].isEmpty()) end = Long.parseLong(p[1]);
                if (start <= end && end < len) partial = true;
                else { start = 0; end = len - 1; }
            } catch (Exception e) { start = 0; end = len - 1; }
        }

        long contentLength = end - start + 1;
        if (partial) {
            ex.getResponseHeaders().set("Content-Range", "bytes " + start + "-" + end + "/" + len);
            ex.sendResponseHeaders(206, contentLength);
        } else {
            ex.sendResponseHeaders(200, len);
            contentLength = len;
        }

        try (OutputStream os = ex.getResponseBody(); FileInputStream fis = new FileInputStream(file)) {
            if (start > 0) {
                long skipped = fis.skip(start);
                if (skipped < start) return;
            }
            byte[] buf = new byte[64 * 1024];
            long remaining = contentLength;
            int n;
            while (remaining > 0 && (n = fis.read(buf, 0, (int) Math.min(buf.length, remaining))) > 0) {
                os.write(buf, 0, n);
                remaining -= n;
            }
        } catch (IOException e) {
            // العميل أغلق الاتصال (إلغاء تحميل فيديو) — سلوك طبيعي
        }
    }

    private void send404(HttpExchange ex, String path) throws IOException {
        String body = "<!doctype html><html lang=\"ar\" dir=\"rtl\"><meta charset=\"utf-8\">"
                + "<title>404</title><body style=\"font-family:system-ui;background:#06070f;color:#eef0ff;"
                + "display:grid;place-items:center;height:100vh;margin:0;text-align:center\">"
                + "<div><h1 style=\"font-size:64px;margin:0\">404</h1>"
                + "<p>الملف غير موجود: <code style=\"direction:ltr\">" + escape(path) + "</code></p>"
                + "<p><a href=\"/\" style=\"color:#00d4ff\">العودة للصفحة الرئيسية</a></p></div></body></html>";
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
        ex.sendResponseHeaders(404, b.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(b); }
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    public static String mimeFor(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        return MIME.getOrDefault(ext, "application/octet-stream");
    }

    /** هل المجلد يبدو كمجلد المشروع الصحيح؟ */
    public static File detectRoot(File here) {
        File[] candidates = {
                here,                       // java-server (لو شُغّل من داخله)
                here.getParentFile(),       // watch_together
                new File("."),              // مجلد العمل الحالي
                new File("watch_together")  // جذر المستودع
        };
        for (File c : candidates) {
            if (c == null) continue;
            if (new File(c, "index.html").isFile() && new File(c, "room.html").isFile()) {
                try { return c.getCanonicalFile(); } catch (IOException e) { return c; }
            }
        }
        return here;
    }

    public static String readFile(File f) throws IOException {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }
}
