package com.watchtogether;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * WatchTogether — خادم Java موحّد (صفحات + مزامنة WebSocket)
 * ------------------------------------------------------------
 *  • لا يحتاج أي مكتبة خارجية: JDK 11+ فقط.
 *  • يقدّم index.html و room.html من المجلد الأب (watch_together/).
 *  • نقطة WebSocket على المسار:  /ws
 *  • نقطة الحالة:                 /api/stats  و /healthz
 *
 *  التشغيل:
 *     cd watch_together/java-server
 *     javac -encoding UTF-8 -d out src/com/watchtogether/*.java
 *     java -cp out com.watchtogether.Main
 *     ثم افتح:  http://localhost:8080
 *
 *  متغيرات اختيارية:
 *     PORT=8080        رقم المنفذ
 *     HOST=0.0.0.0     عنوان الاستماع (0.0.0.0 = كل الواجهات، مطلوب للمعاينة الحية)
 *     ROOT=/path       مجلد الملفات الثابتة
 */
public final class Main {

    private static RoomStore roomStore;
    private static WebSocketServer wsServer;
    private static long startedAt = System.currentTimeMillis();

    public static void main(String[] args) throws Exception {
        int port = intEnv("PORT", args.length > 0 ? parseInt(args[0], 8080) : 8080);
        String host = System.getenv().getOrDefault("HOST", "0.0.0.0");

        File root = StaticFileServer.detectRoot(new File(System.getProperty("user.dir")));
        String rootEnv = System.getenv("ROOT");
        if (rootEnv != null && !rootEnv.trim().isEmpty()) root = new File(rootEnv.trim()).getAbsoluteFile();

        roomStore = new RoomStore();
        roomStore.startAutoPersist(5000);      /* حفظ احتياطي كل 5 ثوانٍ */
        wsServer = new WebSocketServer(roomStore);
        StaticFileServer files = new StaticFileServer(root);

        HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
        server.setExecutor((ThreadPoolExecutor) Executors.newFixedThreadPool(
                Math.max(16, Runtime.getRuntime().availableProcessors() * 4), r -> {
                    Thread t = new Thread(r, "http-worker");
                    t.setDaemon(false);
                    return t;
                }));

        /* المسار الجذر: ترقية WebSocket أولاً، ثم الملفات الثابتة */
        server.createContext("/", (HttpExchange ex) -> {
            String path = ex.getRequestURI().getPath();
            try {
                if (path.equals("/ws") || path.equals("/ws/")) {
                    if (wsServer.handleUpgrade(ex)) return;         // تمّت الترقية
                    sendText(ex, 400, "Bad Request",
                            "هذه نقطة WebSocket — افتح الموقع من المتصفح على /");
                    return;
                }
                if (path.equals("/api/rooms")) { handleRooms(ex); return; }
                if (path.equals("/api/rooms/report")) { handleRoomReport(ex); return; }
                if (path.equals("/api/resolve")) { VideoResolver.handle(ex); return; }
                if (path.equals("/api/stats")) { sendJson(ex, 200, stats()); return; }
                files.handle(ex);
            } catch (IOException e) {
                try { sendText(ex, 500, "Internal Server Error", "خطأ داخلي: " + e.getMessage()); }
                catch (Exception ignored) { }
            } finally {
                ex.close();
            }
        });

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("\n[WatchTogether] إيقاف الخادم…");
            try { wsServer.shutdown(); } catch (Exception ignored) { }
            try { roomStore.shutdown(); } catch (Exception ignored) { }
            server.stop(1);
        }));

        server.start();
        banner(port, host, root);
    }

    private static void handleRooms(HttpExchange ex) throws IOException {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
        if ("OPTIONS".equals(ex.getRequestMethod())) { ex.sendResponseHeaders(204, -1); return; }
        if ("GET".equals(ex.getRequestMethod())) {
            String roomId = queryParam(ex, "room");
            if (roomId != null && !roomId.isEmpty()) {
                try {
                    Map<String, Object> room = roomStore.ownedRoom(roomId.toUpperCase(), queryParam(ex, "ownerToken"));
                    sendJson(ex, 200, Json.map("room", room));
                } catch (SecurityException error) { sendJson(ex, 403, Json.map("error", error.getMessage())); }
                catch (IllegalStateException error) { sendJson(ex, 404, Json.map("error", error.getMessage())); }
                return;
            }
            sendJson(ex, 200, Json.map("rooms", roomStore.publicRooms()));
            return;
        }
        String method = ex.getRequestMethod();
        if (!"POST".equals(method) && !"PUT".equals(method) && !"DELETE".equals(method)) {
            ex.getResponseHeaders().set("Allow", "GET, POST, PUT, DELETE, OPTIONS");
            sendJson(ex, 405, Json.map("error", "طريقة الطلب غير مدعومة"));
            return;
        }
        Map<String, Object> data;
        try { data = readJsonBody(ex, 8192); }
        catch (IllegalArgumentException error) {
            sendJson(ex, 400, Json.map("error", error.getMessage()));
            return;
        }
        try {
            if ("POST".equals(method)) {
                Map<String, Object> room = roomStore.createRoom(Json.str(data, "id", ""), Json.str(data, "title", ""),
                        Json.str(data, "videoUrl", ""), Json.str(data, "ownerToken", ""));
                sendJson(ex, 201, Json.map("room", room));
            } else if ("PUT".equals(method)) {
                String id = Json.str(data, "roomId", "").toUpperCase();
                Map<String, Object> room = roomStore.updateRoom(id, Json.str(data, "ownerToken", ""), data);
                sendJson(ex, 200, Json.map("room", room));
            } else {
                String id = Json.str(data, "roomId", "").toUpperCase();
                boolean deleted = roomStore.deleteRoom(id, Json.str(data, "ownerToken", ""));
                sendJson(ex, 200, Json.map("ok", true, "deleted", deleted));
            }
        } catch (SecurityException error) {
            sendJson(ex, 403, Json.map("error", error.getMessage()));
        } catch (IllegalArgumentException error) {
            sendJson(ex, 400, Json.map("error", error.getMessage()));
        } catch (IllegalStateException error) {
            sendJson(ex, 409, Json.map("error", error.getMessage()));
        }
    }

    private static void handleRoomReport(HttpExchange ex) throws IOException {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "POST, OPTIONS");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
        if ("OPTIONS".equals(ex.getRequestMethod())) { ex.sendResponseHeaders(204, -1); return; }
        if (!"POST".equals(ex.getRequestMethod())) {
            ex.getResponseHeaders().set("Allow", "POST, OPTIONS");
            sendJson(ex, 405, Json.map("error", "طريقة الطلب غير مدعومة"));
            return;
        }
        try {
            Map<String, Object> data = readJsonBody(ex, 8192);
            String roomId = Json.str(data, "roomId", "").toUpperCase();
            roomStore.reportRoom(roomId, Json.str(data, "reporterId", ""), Json.str(data, "reason", ""), Json.str(data, "details", ""));
            sendJson(ex, 201, Json.map("ok", true));
        } catch (IllegalArgumentException error) {
            sendJson(ex, 400, Json.map("error", error.getMessage()));
        } catch (IllegalStateException error) {
            sendJson(ex, 404, Json.map("error", error.getMessage()));
        }
    }

    private static Map<String, Object> readJsonBody(HttpExchange ex, int maxBytes) throws IOException {
        byte[] raw = ex.getRequestBody().readNBytes(maxBytes + 1);
        if (raw.length > maxBytes) throw new IllegalArgumentException("الطلب كبير جداً");
        Map<String, Object> data = Json.parseObject(new String(raw, StandardCharsets.UTF_8));
        if (data == null) throw new IllegalArgumentException("طلب غير صالح");
        return data;
    }

    private static String queryParam(HttpExchange ex, String key) {
        String query = ex.getRequestURI().getRawQuery();
        if (query == null) return null;
        for (String part : query.split("&")) {
            int at = part.indexOf('=');
            String name = at < 0 ? part : part.substring(0, at);
            if (!java.net.URLDecoder.decode(name, StandardCharsets.UTF_8).equals(key)) continue;
            String value = at < 0 ? "" : part.substring(at + 1);
            return java.net.URLDecoder.decode(value, StandardCharsets.UTF_8);
        }
        return null;
    }

    private static Map<String, Object> stats() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("status", "ok");
        m.put("app", "WatchTogether");
        m.put("version", "1.0.0");
        m.put("uptimeSeconds", (System.currentTimeMillis() - startedAt) / 1000);
        m.put("rooms", roomStore.getRoomCount());
        m.put("connections", wsServer.getActiveConnections());
        m.put("totalConnections", wsServer.getTotalConnections());
        m.put("messages", roomStore.getMessageCount());
        m.put("serverTime", System.currentTimeMillis());
        m.put("store", roomStore.getStoreFile().getName());
        return m;
    }

    private static void sendJson(HttpExchange ex, int code, Object body) throws IOException {
        byte[] b = Json.stringify(body).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.sendResponseHeaders(code, b.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(b); }
    }

    private static void sendText(HttpExchange ex, int code, String status, String message) throws IOException {
        byte[] b = message.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        ex.sendResponseHeaders(code, b.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(b); }
    }

    private static int intEnv(String key, int def) {
        String v = System.getenv(key);
        return v == null ? def : parseInt(v, def);
    }

    private static int parseInt(String v, int def) {
        try { return Integer.parseInt(v.trim()); } catch (Exception e) { return def; }
    }

    /* =========================================================
       لافتة التشغيل مع كل العناوين المتاحة
       ========================================================= */
    private static void banner(int port, String host, File root) {
        StringBuilder sb = new StringBuilder();
        sb.append('\n');
        sb.append("  ╔══════════════════════════════════════════════════════════╗\n");
        sb.append("  ║   WatchTogether — خادم Java (صفحات + مزامنة WebSocket)   ║\n");
        sb.append("  ╚══════════════════════════════════════════════════════════╝\n\n");
        sb.append("  مجلد الموقع : ").append(root.getAbsolutePath()).append('\n');
        sb.append("  الاستماع على : ").append(host).append(':').append(port).append('\n');
        sb.append("  WebSocket    : /ws\n");
        sb.append("  حفظ الحالات  : ").append(roomStore.getStoreFile().getAbsolutePath()).append('\n');
        sb.append("  الحالة       : /api/stats\n\n");
        sb.append("  افتح في المتصفح:\n");
        sb.append("    ▸ http://localhost:").append(port).append("/\n");
        for (String ip : localIps()) sb.append("    ▸ http://").append(ip).append(':').append(port).append("/\n");
        sb.append('\n');
        sb.append("  للمشاركة مع صديق: أرسل له رابط الغرفة بعد إنشائها،\n");
        sb.append("  وسيُطلب منه إدخال اسمه ثم يدخل نفس الغرفة فوراً.\n\n");
        sb.append("  (أوقف الخادم بـ Ctrl+C)\n");
        System.out.println(sb);
    }

    private static Iterable<String> localIps() {
        try {
            java.util.List<String> ips = new java.util.ArrayList<>();
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            for (NetworkInterface ni : Collections.list(nis)) {
                if (ni.isLoopback() || !ni.isUp()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof java.net.Inet4Address && !a.isLinkLocalAddress()) ips.add(a.getHostAddress());
                }
            }
            return ips;
        } catch (Exception e) {
            return Collections.emptyList();
        }
    }
}
