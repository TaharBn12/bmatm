package com.watchtogether;

import com.sun.net.httpserver.HttpExchange;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * خادم WebSocket مكتوب من الصفر فوق com.sun.net.httpserver (JDK فقط، بدون مكتبات).
 * ينفّذ RFC 6455 بما يكفي لمشروع WatchTogether:
 *   - مصافحة الترقية (Upgrade + Sec-WebSocket-Accept)
 *   - قراءة/كتابة إطارات نصية مع دعم التقطيع (fragmentation)
 *   - فكّ قناع العميل (masking) وإرسال ping/pong وإغلاق نظيف
 *
 * كل اتصال يُدار في مهمّة خاصة به عبر ExecutorService.
 */
public class WebSocketServer {

    public static final String MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int MAX_MESSAGE_BYTES = 512 * 1024;   // حد الرسالة (512KB)
    private static final int MAX_FRAME_HEADER = 14;

    /** مستمع الأحداث القادمة من المتصفح */
    public interface Listener {
        void onMessage(WsConnection conn, String text);
        void onClose(WsConnection conn);
    }

    private final ThreadPoolExecutor executor;
    private final ScheduledExecutorService scheduler;
    private final Listener listener;
    private final Set<WsConnection> connections = Collections.newSetFromMap(new ConcurrentHashMap<>());
    private final AtomicLong totalConnections = new AtomicLong();

    public WebSocketServer(Listener listener) {
        this.listener = listener;
        this.executor = (ThreadPoolExecutor) Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "ws-conn");
            t.setDaemon(true);
            return t;
        });
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "ws-keepalive");
            t.setDaemon(true);
            return t;
        });
        /* نبضة ping كل 25 ثانية للحفاظ على الاتصالات عبر الوكلاء */
        scheduler.scheduleAtFixedRate(this::pingAll, 25, 25, TimeUnit.SECONDS);
    }

    public long getTotalConnections() { return totalConnections.get(); }
    public int getActiveConnections() { return connections.size(); }

    /** يعالج طلب HTTP: إن كان ترقية WebSocket يقبلها، وإلا يعيد false ليتولّى الخادم الطلب كملف عادي */
    public boolean handleUpgrade(HttpExchange ex) throws IOException {
        Map<String, String> h = Headers.lower(ex);
        String upgrade = h.get("upgrade");
        String key = h.get("sec-websocket-key");
        String version = h.get("sec-websocket-version");

        if (upgrade == null || !upgrade.toLowerCase().contains("websocket") || key == null) return false;

        String accept = acceptKey(key);
        ex.getResponseHeaders().set("Upgrade", "websocket");
        ex.getResponseHeaders().set("Connection", "Upgrade");
        ex.getResponseHeaders().set("Sec-WebSocket-Accept", accept);
        /* نطلب بروتوكولاً فرعياً واحداً فقط إن أرسل العميل قائمة (لتفادي رفض المتصفح) */
        ex.sendResponseHeaders(101, -1);

        WsConnection conn = new WsConnection(ex);
        connections.add(conn);
        totalConnections.incrementAndGet();
        executor.execute(() -> readLoop(conn));
        return true;
    }

    private void pingAll() {
        for (WsConnection c : connections) {
            try { c.sendControl(Opcode.PING, new byte[0]); }
            catch (Exception e) { c.closeQuietly(); }
        }
    }

    public static String acceptKey(String key) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((key.trim() + MAGIC_GUID).getBytes(StandardCharsets.US_ASCII));
            return Base64.getEncoder().encodeToString(digest);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-1 غير متوفر", e);
        }
    }

    /* =========================================================
       حلقة القراءة
       ========================================================= */
    private void readLoop(WsConnection conn) {
        ByteArrayOutputStream fragments = new ByteArrayOutputStream();
        int fragmentOpcode = -1;
        try {
            InputStream in = conn.rawInput();
            while (!conn.isClosed()) {
                Frame f = Frame.read(in);
                if (f == null) break;                       // نهاية التدفق

                switch (f.opcode) {
                    case Opcode.TEXT:
                    case Opcode.BINARY:
                        fragments.reset();
                        fragments.write(f.payload, 0, f.payload.length);
                        fragmentOpcode = f.opcode;
                        if (f.fin) deliver(conn, fragments, fragmentOpcode);
                        break;

                    case Opcode.CONTINUATION:
                        if (fragments.size() + f.payload.length > MAX_MESSAGE_BYTES) {
                            conn.close(Opcode.TOO_BIG, "الرسالة أكبر من الحد المسموح");
                            return;
                        }
                        fragments.write(f.payload, 0, f.payload.length);
                        if (f.fin) deliver(conn, fragments, fragmentOpcode);
                        break;

                    case Opcode.PING:
                        conn.sendControl(Opcode.PONG, f.payload);
                        break;

                    case Opcode.PONG:
                        conn.markAlive();
                        break;

                    case Opcode.CLOSE:
                        conn.echoClose(f.payload);
                        return;

                    default:
                        // إطار غير معروف → تجاهل
                }
            }
        } catch (IOException e) {
            // انقطاع طبيعي للاتصال
        } finally {
            close(conn);
        }
    }

    private void deliver(WsConnection conn, ByteArrayOutputStream buf, int opcode) {
        byte[] data = buf.toByteArray();
        buf.reset();
        if (opcode == Opcode.TEXT) {
            String text = new String(data, StandardCharsets.UTF_8);
            try { listener.onMessage(conn, text); }
            catch (Exception e) { System.err.println("[WS] خطأ في معالجة الرسالة: " + e); }
        }
        // الإطارات الثنائية غير مستخدمة في هذا المشروع
    }

    private void close(WsConnection conn) {
        if (connections.remove(conn)) {
            conn.markClosed();
            try { listener.onClose(conn); } catch (Exception ignored) { }
            conn.closeQuietly();
        }
    }

    public void shutdown() {
        for (WsConnection c : new ArrayList<>(connections)) c.closeQuietly();
        executor.shutdownNow();
        scheduler.shutdownNow();
    }

    /* =========================================================
       الإطارات (RFC 6455 §5)
       ========================================================= */
    static final class Opcode {
        static final int CONTINUATION = 0x0, TEXT = 0x1, BINARY = 0x2, CLOSE = 0x8, PING = 0x9, PONG = 0xA;
        static final int TOO_BIG = 1009;
        private Opcode() {}
    }

    static final class Frame {
        boolean fin;
        int opcode;
        byte[] payload;

        static Frame read(InputStream in) throws IOException {
            int b0 = in.read();
            if (b0 < 0) return null;
            int b1 = in.read();
            if (b1 < 0) return null;

            Frame f = new Frame();
            f.fin = (b0 & 0x80) != 0;
            f.opcode = b0 & 0x0F;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7F;

            if (len == 126) {
                len = ((long) readU8(in) << 8) | readU8(in);
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | readU8(in);
            }
            if (len < 0 || len > MAX_MESSAGE_BYTES) throw new IOException("حجم إطار غير مسموح: " + len);

            byte[] mask = null;
            if (masked) {
                mask = new byte[4];
                readFully(in, mask);
            }

            byte[] payload = new byte[(int) len];
            readFully(in, payload);
            if (mask != null) {
                for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            }
            f.payload = payload;
            return f;
        }

        private static int readU8(InputStream in) throws IOException {
            int v = in.read();
            if (v < 0) throw new IOException("نهاية التدفق أثناء قراءة الطول");
            return v;
        }

        private static void readFully(InputStream in, byte[] buf) throws IOException {
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n < 0) throw new IOException("نهاية التدفق أثناء قراءة الحمولة");
                off += n;
            }
        }
    }

    /** كتابة إطار نصي (بدون قناع، كما يلزم الخادم) */
    public static byte[] encodeTextFrame(String text) {
        byte[] payload = text.getBytes(StandardCharsets.UTF_8);
        return encodeFrame(Opcode.TEXT, payload, true);
    }

    public static byte[] encodeFrame(int opcode, byte[] payload, boolean fin) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(payload.length + MAX_FRAME_HEADER);
        out.write((fin ? 0x80 : 0x00) | (opcode & 0x0F));
        int len = payload.length;
        if (len < 126) {
            out.write(len);
        } else if (len <= 0xFFFF) {
            out.write(126);
            out.write((len >>> 8) & 0xFF);
            out.write(len & 0xFF);
        } else {
            out.write(127);
            for (int i = 7; i >= 0; i--) out.write((int) ((long) len >>> (8 * i)) & 0xFF);
        }
        out.write(payload, 0, payload.length);
        return out.toByteArray();
    }

    /* =========================================================
       الاتصال
       ========================================================= */
    public final class WsConnection {
        private final HttpExchange exchange;
        private final InputStream in;
        private final OutputStream out;
        private final String id = UUID.randomUUID().toString();
        private volatile boolean closed = false;
        private volatile long lastAlive = System.currentTimeMillis();
        /** بيانات ربطها التطبيق (مثل اسم الغرفة والمستخدم) */
        public final Map<String, Object> attrs = new ConcurrentHashMap<>();
        private final Object writeLock = new Object();

        WsConnection(HttpExchange ex) throws IOException {
            this.exchange = ex;
            this.in = ex.getRequestBody();
            this.out = ex.getResponseBody();
        }

        public String getId() { return id; }
        public boolean isClosed() { return closed; }
        InputStream rawInput() { return in; }
        public InetSocketAddress remoteAddress() { return exchange.getRemoteAddress(); }

        void markAlive() { lastAlive = System.currentTimeMillis(); }
        public long getLastAlive() { return lastAlive; }

        public void send(String text) {
            if (closed || text == null) return;
            byte[] frame = encodeTextFrame(text);
            synchronized (writeLock) {
                if (closed) return;
                try {
                    out.write(frame);
                    out.flush();
                } catch (IOException e) {
                    closeQuietly();
                }
            }
        }

        public void send(Map<String, Object> obj) { send(Json.stringify(obj)); }

        void sendControl(int opcode, byte[] payload) throws IOException {
            if (closed) return;
            byte[] frame = encodeFrame(opcode, payload == null ? new byte[0] : payload, true);
            synchronized (writeLock) {
                if (closed) return;
                out.write(frame);
                out.flush();
            }
        }

        void echoClose(byte[] payload) {
            try { sendControl(Opcode.CLOSE, payload == null ? new byte[0] : payload); } catch (Exception ignored) { }
            closeQuietly();
        }

        public void close(int code, String reason) {
            byte[] body = new byte[2 + (reason == null ? 0 : reason.getBytes(StandardCharsets.UTF_8).length)];
            body[0] = (byte) ((code >>> 8) & 0xFF);
            body[1] = (byte) (code & 0xFF);
            if (reason != null) {
                byte[] rb = reason.getBytes(StandardCharsets.UTF_8);
                System.arraycopy(rb, 0, body, 2, rb.length);
            }
            echoClose(body);
        }

        void markClosed() { closed = true; }

        void closeQuietly() {
            closed = true;
            try { out.close(); } catch (Exception ignored) { }
            try { in.close(); } catch (Exception ignored) { }
            try { exchange.close(); } catch (Exception ignored) { }
        }
    }

    /* =========================================================
       أدوات الغرف: بثّ لمجموعة اتصالات
       ========================================================= */
    public void broadcast(Iterable<WsConnection> conns, Map<String, Object> message, WsConnection except) {
        String text = Json.stringify(message);
        for (WsConnection c : conns) {
            if (except != null && c == except) continue;
            if (!c.isClosed()) c.send(text);
        }
    }

    public List<Map<String, Object>> snapshotConnections() {
        List<Map<String, Object>> list = new ArrayList<>();
        for (WsConnection c : connections) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.getId());
            m.put("room", c.attrs.get("room"));
            m.put("name", c.attrs.get("name"));
            m.put("host", c.attrs.get("host"));
            list.add(m);
        }
        return list;
    }
}
