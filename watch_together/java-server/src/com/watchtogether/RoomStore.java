package com.watchtogether;

import com.watchtogether.WebSocketServer.WsConnection;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * مخزن الغرف في الذاكرة + بروتوكول المزامنة والدردشة.
 *
 * البروتوكول (JSON عبر WebSocket على المسار /ws):
 *   العميل → الخادم:
 *     {type:"join",     room, client, name}
 *     {type:"state",    room, state:{url,kind,playing,pos,t,hostId,hostName,seq}}
 *     {type:"chat",     room, message:{name,text,kind}}
 *     {type:"presence", clientId, name, host}
 *     {type:"typing",   clientId, name}
 *     {type:"leave",    clientId}
 *
 *   الخادم → العميل:
 *     {type:"welcome",  state, messages[], members[], serverTime}
 *     {type:"state",    state}
 *     {type:"chat",     message, sender}
 *     {type:"presence", clientId, name, host, left?}
 *     {type:"typing",   clientId, name}
 *     {type:"members",  members[]}
 *     {type:"system",   text}
 */
public final class RoomStore implements WebSocketServer.Listener {

    private static final int MAX_HISTORY = 150;
    private static final long PRESENCE_TTL_MS = 12_000;

    /** غرفة واحدة */
    public static final class Room {
        final String id;
        final Set<WsConnection> members = Collections.newSetFromMap(new ConcurrentHashMap<>());
        final List<Map<String, Object>> history = Collections.synchronizedList(new ArrayList<>());
        /** آخر حالة مزامنة (من أي مشارك يتحكم) */
        volatile Map<String, Object> state;
        volatile String hostId;
        volatile String hostName;
        /**
         * رقم تسلسلي مركزي (ساعة منطقية).
         * الخادم هو من يرقّم كل تحديث → يستحيل أن يبثّ مشاركان رقمَين متساويين،
         * وهو ما كان يجمّد المزامنة ويجعل كل واحد يظنّ نفسه في غرفة وحده.
         */
        final AtomicLong rev = new AtomicLong();
        /** متى حُفظت الحالة آخر مرة (لحساب الوقت عند انضمام متأخر) */
        volatile long lastSavedAt = 0L;
        final AtomicLong messagesCount = new AtomicLong();

        Room(String id) { this.id = id; }
    }

    private final Map<String, Room> rooms = new ConcurrentHashMap<>();
    private final ScheduledExecutorService janitor;
    /** ملف حفظ حالات الغرف حتى لا تضيع عند إعادة تشغيل الخادم */
    private final File storeFile;

    public RoomStore() { this(new File(System.getProperty("wt.data", "data"), "rooms.json")); }

    public RoomStore(File storeFile) {
        this.storeFile = storeFile;
        janitor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "room-janitor");
            t.setDaemon(true);
            return t;
        });
        /* كل 10 ثوانٍ: احذف الحضور المنتهي والغرف الفارغة */
        janitor.scheduleAtFixedRate(this::sweep, 10, 10, TimeUnit.SECONDS);
        loadFromDisk();
    }

    /* =========================================================
       حفظ/استرجاع حالة الغرف (آخر مستخدم يخرج → حفظ فوري)
       ========================================================= */
    @SuppressWarnings("unchecked")
    private void loadFromDisk() {
        try {
            if (storeFile == null || !storeFile.isFile()) return;
            String raw = new String(Files.readAllBytes(storeFile.toPath()), StandardCharsets.UTF_8);
            Map<String, Object> root = Json.parseObject(raw);
            if (root == null) return;
            Object roomsObj = root.get("rooms");
            if (!(roomsObj instanceof Map)) return;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) roomsObj).entrySet()) {
                Map<String, Object> rec = Json.asMap(e.getValue());
                if (rec == null) continue;
                Room r = new Room(e.getKey());
                r.state = Json.asMap(rec.get("state"));
                /* استأنف الترقيم من حيث توقّف، لا من الصفر */
                if (r.state != null && r.state.get("rev") instanceof Number) {
                    r.rev.set(Math.max(0, ((Number) r.state.get("rev")).longValue()));
                }
                Object hist = rec.get("messages");
                if (hist instanceof List) {
                    for (Object o : (List<Object>) hist) {
                        Map<String, Object> m = Json.asMap(o);
                        if (m != null) r.history.add(m);
                    }
                }
                rooms.put(e.getKey(), r);
            }
            System.out.println("[Rooms] تم استرجاع " + rooms.size() + " غرفة من " + storeFile.getName());
        } catch (Exception e) {
            System.err.println("[Rooms] تعذّر استرجاع الحالات: " + e.getMessage());
        }
    }

    /** احفظ كل الحالات على القرص (آمن: لا يرمي استثناءات) */
    public synchronized void persist() {
        try {
            if (storeFile == null) return;
            File parent = storeFile.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return;

            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<String, Room> e : rooms.entrySet()) {
                Room r = e.getValue();
                Map<String, Object> rec = new LinkedHashMap<>();
                rec.put("state", r.state);
                rec.put("savedAt", System.currentTimeMillis());
                synchronized (r.history) { rec.put("messages", new ArrayList<>(r.history)); }
                out.put(e.getKey(), rec);
            }
            Map<String, Object> root = new LinkedHashMap<>();
            root.put("version", 1);
            root.put("savedAt", System.currentTimeMillis());
            root.put("rooms", out);

            File tmp = new File(storeFile.getAbsolutePath() + ".tmp");
            Files.write(tmp.toPath(), Json.stringify(root).getBytes(StandardCharsets.UTF_8));
            if (storeFile.isFile() && !storeFile.delete()) { /* تجاهل */ }
            if (!tmp.renameTo(storeFile)) {
                Files.write(storeFile.toPath(), Json.stringify(root).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            System.err.println("[Rooms] تعذّر الحفظ: " + e.getMessage());
        }
    }

    private Room room(String id) {
        return rooms.computeIfAbsent(id == null ? "?" : id.toUpperCase(), Room::new);
    }

    public int getRoomCount() { return rooms.size(); }

    public long getMessageCount() {
        long n = 0;
        for (Room r : rooms.values()) n += r.messagesCount.get();
        return n;
    }

    /* =========================================================
       معالجة الرسائل
       ========================================================= */
    @Override
    public void onMessage(WsConnection conn, String text) {
        Map<String, Object> msg;
        try {
            msg = Json.parseObject(text);
        } catch (Exception e) {
            conn.send(Json.map("type", "error", "message", "رسالة JSON غير صالحة"));
            return;
        }
        if (msg == null) return;

        String type = Json.str(msg, "type", "");
        String roomId = normalizeRoom(Json.str(msg, "room", (String) conn.attrs.get("room")));

        switch (type) {
            case "join":     join(conn, roomId, msg); break;
            case "state":    handleState(conn, roomId, msg); break;
            case "chat":     handleChat(conn, roomId, msg); break;
            case "presence": handlePresence(conn, roomId, msg); break;
            case "typing":   handleTyping(conn, roomId, msg); break;
            case "leave":    leave(conn, true); break;
            case "ping":     conn.send(Json.map("type", "pong", "serverTime", System.currentTimeMillis())); break;
            default:         conn.send(Json.map("type", "error", "message", "نوع رسالة غير معروف: " + type));
        }
    }

    private static String normalizeRoom(String id) {
        if (id == null) return "?";
        String clean = id.toUpperCase().replaceAll("[^A-Z0-9]", "");
        return clean.isEmpty() ? "?" : (clean.length() > 12 ? clean.substring(0, 12) : clean);
    }

    private void join(WsConnection conn, String roomId, Map<String, Object> msg) {
        Room r = room(roomId);
        String clientId = Json.str(msg, "client", conn.getId());
        String name = Json.str(msg, "name", "زائر");

        /* اقطع أي اتصال قديم بنفس معرّف العميل (إعادة تحميل الصفحة) */
        for (WsConnection other : new ArrayList<>(r.members)) {
            if (other != conn && clientId.equals(other.attrs.get("clientId"))) leave(other, false);
        }

        conn.attrs.put("room", roomId);
        conn.attrs.put("clientId", clientId);
        conn.attrs.put("name", name);
        conn.attrs.put("host", Boolean.FALSE);
        conn.attrs.put("lastSeen", System.currentTimeMillis());

        /* هل كانت الغرفة فارغة (أي أن الحالة محفوظة من جلسة سابقة)؟ */
        boolean rejoinedSavedRoom = r.members.isEmpty() && r.state != null && r.lastSavedAt > 0;
        r.members.add(conn);

        /* التحاق متأخر: حدّث الطابع الزمني للحالة المحفوظة حتى يأخذ الداخل
           الجديد الوقت الحالي المحسوب — لا يبدأ من لحظة الحفظ القديمة */
        Map<String, Object> stateOut = r.state;
        if (rejoinedSavedRoom) {
            long ageMs = System.currentTimeMillis() - r.lastSavedAt;
            if (ageMs > 0) {
                stateOut = new LinkedHashMap<>(stateOut);
                Object t = stateOut.get("t");
                long base = (t instanceof Number) ? ((Number) t).longValue() : r.lastSavedAt;
                stateOut.put("t", base + ageMs);
                stateOut.put("resumedAfter", ageMs);
                r.state = stateOut;
                r.lastSavedAt = System.currentTimeMillis();
            }
        }

        Map<String, Object> welcome = new LinkedHashMap<>();
        welcome.put("type", "welcome");
        welcome.put("room", roomId);
        welcome.put("state", stateOut);
        welcome.put("serverTime", System.currentTimeMillis());
        welcome.put("messages", snapshotHistory(r));
        welcome.put("members", memberList(r));
        welcome.put("lastSavedAt", r.lastSavedAt);
        conn.send(welcome);

        /* أشعر البقية */
        broadcastPresence(r, conn, false);
        broadcast(r, Json.map("type", "system", "text", name + " دخل الغرفة 👋"), null);
        sendMembers(r);
    }

    private void handleState(WsConnection conn, String roomId, Map<String, Object> msg) {
        Room r = room(roomId);
        Map<String, Object> state = Json.asMap(msg.get("state"));
        if (state == null) return;

        String selfId = String.valueOf(conn.attrs.get("clientId"));
        String hostId = Json.str(state, "updatedBy", Json.str(state, "hostId", selfId));
        String hostName = Json.str(state, "updatedByName",
                Json.str(state, "hostName", Json.str(conn.attrs, "name", "مضيف")));

        /* التحكم متاح لأي مشارك: آخر إجراء يفوز (last-write-wins).
           الخادم يرقّم كل تحديث تسلسلياً فيبقى الترتيب واحداً عند الجميع،
           ونبثّها للكل (حتى المرسل) ليعرف الرقم المعتمد ويكمل فوقه. */
        Object revIn = state.get("rev");
        if (revIn instanceof Number) {
            final long seen = ((Number) revIn).longValue();
            r.rev.updateAndGet(cur -> Math.max(cur, seen));
        }
        long rev = r.rev.incrementAndGet();

        Map<String, Object> stored = new LinkedHashMap<>(state);
        stored.put("rev", rev);
        stored.put("hostId", hostId);
        stored.put("hostName", hostName);
        stored.put("updatedBy", hostId);
        stored.put("updatedByName", hostName);

        r.state = stored;
        r.hostId = hostId;
        r.hostName = hostName;
        r.lastSavedAt = System.currentTimeMillis();
        conn.attrs.put("host", Boolean.TRUE);
        conn.attrs.put("name", hostName);
        conn.attrs.put("lastSeen", System.currentTimeMillis());

        /* نبثّها للجميع بمن فيهم المرسل: الواجهة تتجاهل صداها عبر حقل sender */
        broadcast(r, Json.map("type", "state", "state", stored, "sender", conn.attrs.get("clientId")), null);
    }

    private void handleChat(WsConnection conn, String roomId, Map<String, Object> msg) {
        Room r = room(roomId);
        Map<String, Object> m = Json.asMap(msg.get("message"));
        if (m == null) return;

        String text = Json.str(m, "text", "").trim();
        if (text.isEmpty()) return;
        if (text.length() > 1000) text = text.substring(0, 1000);

        Map<String, Object> stored = new LinkedHashMap<>();
        stored.put("id", "s-" + System.nanoTime());
        stored.put("name", Json.str(m, "name", Json.str(conn.attrs, "name", "زائر")));
        stored.put("text", text);
        stored.put("kind", Json.str(m, "kind", "chat"));
        stored.put("ts", System.currentTimeMillis());
        stored.put("client", conn.attrs.get("clientId"));

        synchronized (r.history) {
            r.history.add(stored);
            while (r.history.size() > MAX_HISTORY) r.history.remove(0);
        }
        r.messagesCount.incrementAndGet();
        conn.attrs.put("lastSeen", System.currentTimeMillis());

        /* نبثّها للجميع (بما فيهم المرسل) — والواجهة تتجاهل نسختها عبر حقل sender */
        Map<String, Object> out = Json.map("type", "chat", "message", stored, "sender", conn.attrs.get("clientId"));
        broadcast(r, out, null);
    }

    private void handlePresence(WsConnection conn, String roomId, Map<String, Object> msg) {
        Room r = room(roomId);
        String name = Json.str(msg, "name", Json.str(conn.attrs, "name", "زائر"));
        boolean host = Json.bool(msg, "host", false);
        conn.attrs.put("name", name);
        conn.attrs.put("host", host);
        conn.attrs.put("lastSeen", System.currentTimeMillis());
        if (host) {
            r.hostId = Json.str(msg, "clientId", String.valueOf(conn.attrs.get("clientId")));
            r.hostName = name;
            conn.attrs.put("host", Boolean.TRUE);
        }

        broadcastPresence(r, conn, false);
        sendMembers(r);
    }

    private void handleTyping(WsConnection conn, String roomId, Map<String, Object> msg) {
        Room r = room(roomId);
        conn.attrs.put("lastSeen", System.currentTimeMillis());
        broadcast(r, Json.map("type", "typing",
                "clientId", Json.str(msg, "clientId", (String) conn.attrs.get("clientId")),
                "name", Json.str(msg, "name", Json.str(conn.attrs, "name", "زائر"))), conn);
    }

    /* =========================================================
       المغادرة والإغلاق
       ========================================================= */
    @Override
    public void onClose(WsConnection conn) { leave(conn, true); }

    private void leave(WsConnection conn, boolean announce) {
        Object roomId = conn.attrs.get("room");
        if (roomId == null) return;
        Room r = rooms.get(String.valueOf(roomId));
        conn.attrs.remove("room");
        if (r == null) return;
        boolean was = r.members.remove(conn);
        if (!was) return;

        String name = Json.str(conn.attrs, "name", "زائر");
        if (announce) {
            broadcastPresence(r, conn, true);
            broadcast(r, Json.map("type", "system", "text", name + " غادر الغرفة 👋"), null);
            sendMembers(r);
        }
        /* آخر مشارك خرج → ارفع/احفظ وقت الغرفة تلقائياً */
        if (r.members.isEmpty()) {
            r.lastSavedAt = System.currentTimeMillis();
            if (r.state != null) {
                Map<String, Object> s = new LinkedHashMap<>(r.state);
                s.put("t", r.lastSavedAt);           /* ختم زمني دقيق لوقت الخروج */
                s.put("savedOnExit", Boolean.TRUE);
                r.state = s;
            }
            persist();
            System.out.println("[Rooms] آخر مشارك غادر الغرفة " + r.id + " — تم حفظ الحالة ("
                    + (r.state == null ? "بلا فيديو" : "الثانية " + r.state.get("pos")) + ")");
            return;
        }

        /* من يتحكم غادر لكن بقي آخرون → حرّر الملكية ليتولاها أي مشارك */
        Object clientId = conn.attrs.get("clientId");
        if (clientId != null && clientId.equals(r.hostId)) {
            r.hostId = null;
            r.hostName = null;
            broadcast(r, Json.map("type", "system",
                    "text", "غادر من كان يتحكم — يمكن لأي مشارك التحكم الآن"), null);
        }
    }

    /* =========================================================
       مساعدات
       ========================================================= */
    private void broadcastPresence(Room r, WsConnection conn, boolean left) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "presence");
        m.put("clientId", conn.attrs.get("clientId"));
        m.put("name", conn.attrs.get("name"));
        m.put("host", Boolean.TRUE.equals(conn.attrs.get("host")));
        m.put("left", left);
        broadcast(r, m, left ? null : conn);
    }

    private void sendMembers(Room r) {
        broadcast(r, Json.map("type", "members", "members", memberList(r)), null);
    }

    private List<Map<String, Object>> memberList(Room r) {
        List<Map<String, Object>> list = new ArrayList<>();
        for (WsConnection c : r.members) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.attrs.get("clientId"));
            m.put("name", c.attrs.get("name"));
            m.put("host", Boolean.TRUE.equals(c.attrs.get("host")));
            list.add(m);
        }
        /* المضيف أولاً */
        list.sort((a, b) -> Boolean.compare(Boolean.TRUE.equals(b.get("host")), Boolean.TRUE.equals(a.get("host"))));
        return list;
    }

    private List<Map<String, Object>> snapshotHistory(Room r) {
        synchronized (r.history) { return new ArrayList<>(r.history); }
    }

    private void broadcast(Room r, Map<String, Object> message, WsConnection except) {
        for (WsConnection c : r.members) {
            if (except != null && c == except) continue;
            c.send(message);
        }
    }

    /** حذف الاتصالات الصامتة والغرف الفارغة */
    private void sweep() {
        try {
            long now = System.currentTimeMillis();
            for (Map.Entry<String, Room> e : rooms.entrySet()) {
                Room r = e.getValue();
                for (WsConnection c : new ArrayList<>(r.members)) {
                    Object seen = c.attrs.get("lastSeen");
                    boolean stale = c.isClosed() || (seen instanceof Long && now - (Long) seen > PRESENCE_TTL_MS * 3);
                    if (stale) leave(c, true);
                }
                if (r.members.isEmpty() && now - lastActivity(r) > 600_000) rooms.remove(e.getKey());
            }
        } catch (Exception ignored) { }
    }

    private long lastActivity(Room r) {
        long latest = 0;
        synchronized (r.history) {
            if (!r.history.isEmpty()) {
                Object ts = r.history.get(r.history.size() - 1).get("ts");
                if (ts instanceof Number) latest = ((Number) ts).longValue();
            }
        }
        return latest;
    }

    /** حفظ احتياطي دوري (يضمن عدم ضياع الحالة لو انقطع الخادم فجأة) */
    public void startAutoPersist(long periodMs) {
        janitor.scheduleAtFixedRate(() -> {
            if (!rooms.isEmpty()) persist();
        }, periodMs, periodMs, TimeUnit.MILLISECONDS);
    }

    public File getStoreFile() { return storeFile; }

    public void shutdown() {
        persist();
        janitor.shutdownNow();
    }
}
