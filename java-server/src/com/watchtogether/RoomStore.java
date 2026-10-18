package com.watchtogether;

import com.watchtogether.WebSocketServer.WsConnection;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
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

    private static final class RoomMember {
        volatile String name;
        volatile String role;
        final String tokenHash;
        RoomMember(String name, String role, String tokenHash) {
            this.name = name; this.role = role; this.tokenHash = tokenHash;
        }
    }

    /** غرفة واحدة */
    public static final class Room {
        final String id;
        volatile String title;
        volatile String videoUrl = "";
        volatile long createdAt = System.currentTimeMillis();
        final Set<WsConnection> members = Collections.newSetFromMap(new ConcurrentHashMap<>());
        final List<Map<String, Object>> history = Collections.synchronizedList(new ArrayList<>());
        final List<Map<String, Object>> queue = Collections.synchronizedList(new ArrayList<>());
        final Map<String, RoomMember> memberInfo = new ConcurrentHashMap<>();
        /** SHA-256 للأسرار فقط؛ لا تُحفظ مفاتيح التحكم بصيغتها الأصلية. */
        volatile String ownerTokenHash;
        /** آخر حالة مزامنة (منشئ الغرفة والمنظّمون فقط يكتبونها) */
        volatile Map<String, Object> state;
        volatile String hostId;
        volatile String hostName;
        final AtomicLong queueSeq = new AtomicLong();
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
                r.title = Json.str(rec, "title", "غرفة " + r.id);
                r.videoUrl = Json.str(rec, "videoUrl", "");
                if (rec.get("createdAt") instanceof Number) r.createdAt = ((Number) rec.get("createdAt")).longValue();
                Object ownerHash = rec.get("ownerTokenHash");
                r.ownerTokenHash = ownerHash == null ? null : String.valueOf(ownerHash);
                Map<String, Object> memberInfo = Json.asMap(rec.get("memberInfo"));
                if (memberInfo != null) {
                    for (Map.Entry<String, Object> me : memberInfo.entrySet()) {
                        Map<String, Object> row = Json.asMap(me.getValue());
                        if (row == null) continue;
                        r.memberInfo.put(me.getKey(), new RoomMember(
                                Json.str(row, "name", "زائر"), Json.str(row, "role", "viewer"), Json.str(row, "tokenHash", "")));
                    }
                }
                Object savedQueue = rec.get("queue");
                if (savedQueue instanceof List) {
                    for (Object item : (List<Object>) savedQueue) {
                        Map<String, Object> row = Json.asMap(item);
                        if (row != null) r.queue.add(row);
                    }
                }
                Object savedQueueSeq = rec.get("queueSeq");
                if (savedQueueSeq instanceof Number) r.queueSeq.set(((Number) savedQueueSeq).longValue());
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
                rec.put("title", r.title);
                rec.put("videoUrl", r.videoUrl);
                rec.put("createdAt", r.createdAt);
                rec.put("ownerTokenHash", r.ownerTokenHash);
                rec.put("savedAt", System.currentTimeMillis());
                Map<String, Object> memberInfo = new LinkedHashMap<>();
                for (Map.Entry<String, RoomMember> member : r.memberInfo.entrySet()) {
                    RoomMember m = member.getValue();
                    memberInfo.put(member.getKey(), Json.map("name", m.name, "role", m.role, "tokenHash", m.tokenHash));
                }
                rec.put("memberInfo", memberInfo);
                synchronized (r.history) { rec.put("messages", new ArrayList<>(r.history)); }
                synchronized (r.queue) { rec.put("queue", new ArrayList<>(r.queue)); }
                rec.put("queueSeq", r.queueSeq.get());
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

    private static String tokenHash(String token) {
        if (token == null || token.isEmpty()) return "";
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) out.append(String.format("%02x", b & 0xff));
            return out.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 غير متاح", impossible);
        }
    }

    private static boolean tokenMatches(String expectedHash, String suppliedHash) {
        if (expectedHash == null || suppliedHash == null) return false;
        return MessageDigest.isEqual(expectedHash.getBytes(StandardCharsets.US_ASCII),
                suppliedHash.getBytes(StandardCharsets.US_ASCII));
    }

    /** Lobby snapshots are an explicit whitelist, never a Room/state/credential dump. */
    private Map<String, Object> publicRoom(Room r) {
        String url = r.state == null ? r.videoUrl : Json.str(r.state, "url", r.videoUrl);
        long now = System.currentTimeMillis();
        Map<String, Map<String, Object>> current = new LinkedHashMap<>();
        for (WsConnection connection : r.members) {
            Object seen = connection.attrs.get("lastSeen");
            String id = Json.str(connection.attrs, "clientId", "");
            if (connection.isClosed() || id.isEmpty() || !(seen instanceof Number)
                    || now - ((Number) seen).longValue() > PRESENCE_TTL_MS) continue;
            current.put(id, Json.map("id", id, "name", Json.str(connection.attrs, "name", "زائر")));
        }
        List<Map<String, Object>> people = new ArrayList<>(current.values());
        people.sort((a, b) -> String.valueOf(a.get("id")).compareTo(String.valueOf(b.get("id"))));
        int count = people.size();
        if (people.size() > 5) people = new ArrayList<>(people.subList(0, 5));
        return Json.map("id", r.id, "title", r.title == null ? "غرفة " + r.id : r.title,
                "videoUrl", url, "createdAt", r.createdAt, "participants", people, "participantCount", count);
    }

    public List<Map<String, Object>> publicRooms() {
        List<Map<String, Object>> list = new ArrayList<>();
        for (Room r : rooms.values()) {
            if (r.ownerTokenHash != null && !r.ownerTokenHash.isEmpty()) list.add(publicRoom(r));
        }
        list.sort((a, b) -> Long.compare(((Number) b.get("createdAt")).longValue(), ((Number) a.get("createdAt")).longValue()));
        return list.size() > 100 ? new ArrayList<>(list.subList(0, 100)) : list;
    }

    public Map<String, Object> createRoom(String id, String title, String videoUrl, String ownerToken) {
        if (id == null || !id.matches("[A-Z0-9]{4,12}") || ownerToken == null || !ownerToken.matches("[a-fA-F0-9]{48,128}")) {
            throw new IllegalArgumentException("بيانات الغرفة غير صالحة");
        }
        title = title == null ? "" : title.strip();
        if (title.isEmpty()) throw new IllegalArgumentException("أدخل اسم الغرفة");
        if (title.length() > 40) title = title.substring(0, 40);
        videoUrl = videoUrl == null ? "" : videoUrl.strip();
        if (!videoUrl.isEmpty()) {
            try {
                java.net.URI uri = java.net.URI.create(videoUrl);
                if (videoUrl.length() > 2048 || !("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))
                        || uri.getHost() == null || uri.getUserInfo() != null) throw new IllegalArgumentException();
            } catch (IllegalArgumentException error) { throw new IllegalArgumentException("رابط الفيديو غير صالح"); }
        }
        Room r = room(id);
        synchronized (r) {
            String hash = tokenHash(ownerToken);
            if (r.ownerTokenHash != null && !r.ownerTokenHash.isEmpty() && !tokenMatches(r.ownerTokenHash, hash)) {
                throw new IllegalStateException("كود الغرفة مستخدم بالفعل — أعد المحاولة");
            }
            r.ownerTokenHash = hash;
            r.title = title;
            r.videoUrl = videoUrl;
            if (r.state == null && !videoUrl.isEmpty()) {
                r.state = Json.map("url", videoUrl, "kind", "", "playing", false, "pos", 0,
                        "t", System.currentTimeMillis(), "rev", 0);
                r.lastSavedAt = System.currentTimeMillis();
            }
        }
        persist();
        return publicRoom(r);
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
        Object joinedRoom = conn.attrs.get("room");
        if (!"join".equals(type) && !"leave".equals(type) && !"ping".equals(type)
                && (joinedRoom == null || !roomId.equals(String.valueOf(joinedRoom)))) {
            conn.send(Json.map("type", "error", "code", "permission", "message", "انضم إلى الغرفة أولاً"));
            return;
        }

        switch (type) {
            case "join":     join(conn, roomId, msg); break;
            case "state":    handleState(conn, roomId, msg); break;
            case "chat":     handleChat(conn, roomId, msg); break;
            case "presence": handlePresence(conn, roomId, msg); break;
            case "typing":   handleTyping(conn, roomId, msg); break;
            case "setRole":  handleSetRole(conn, roomId, msg); break;
            case "queue":    handleQueue(conn, roomId, msg); break;
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
        if (clientId == null || clientId.isEmpty()) clientId = conn.getId();
        if (clientId.length() > 128) {
            conn.send(Json.map("type", "error", "code", "permission", "message", "معرّف العضو غير صالح"));
            conn.close(1008, "invalid client id");
            return;
        }
        if (name.length() > 30) name = name.substring(0, 30);
        String ownerToken = Json.str(msg, "ownerToken", "");
        String memberToken = Json.str(msg, "memberToken", ownerToken);
        if (memberToken == null || memberToken.length() < 48 || memberToken.length() > 256
                || (!ownerToken.isEmpty() && (ownerToken.length() < 48 || ownerToken.length() > 256))) {
            conn.send(Json.map("type", "error", "code", "permission", "message", "مفتاح العضو غير صالح"));
            conn.close(1008, "invalid member token");
            return;
        }
        String ownerHash = tokenHash(ownerToken);
        String memberHash = tokenHash(memberToken);
        boolean claimsRoom = Json.bool(msg, "host", false) && !ownerToken.isEmpty();
        boolean isOwner;
        String role;

        synchronized (r) {
            if ((r.ownerTokenHash == null || r.ownerTokenHash.isEmpty()) && claimsRoom) r.ownerTokenHash = ownerHash;
            isOwner = r.ownerTokenHash != null && !r.ownerTokenHash.isEmpty() && tokenMatches(r.ownerTokenHash, ownerHash);
            RoomMember known = r.memberInfo.get(clientId);
            if (known != null && !isOwner && !tokenMatches(known.tokenHash, memberHash)) {
                conn.send(Json.map("type", "error", "code", "permission", "message", "رمز العضو غير صالح"));
                conn.close(1008, "invalid member token");
                return;
            }
            role = isOwner ? "owner" : (known == null ? "viewer" : known.role);
            if (known == null || isOwner) {
                r.memberInfo.put(clientId, new RoomMember(name, role, isOwner ? ownerHash : memberHash));
            } else {
                known.name = name;
            }
        }

        /* اقطع اتصالاً قديماً بنفس الهوية بعد التحقق من سرّ العضو. */
        for (WsConnection other : new ArrayList<>(r.members)) {
            if (other != conn && clientId.equals(other.attrs.get("clientId"))) leave(other, false);
        }

        conn.attrs.put("room", roomId);
        conn.attrs.put("clientId", clientId);
        conn.attrs.put("name", name);
        conn.attrs.put("role", role);
        conn.attrs.put("host", "owner".equals(role));
        conn.attrs.put("lastSeen", System.currentTimeMillis());
        if (isOwner) { r.hostId = clientId; r.hostName = name; }

        boolean rejoinedSavedRoom = r.members.isEmpty() && r.state != null && r.lastSavedAt > 0;
        r.members.add(conn);

        Map<String, Object> stateOut = r.state;
        if (rejoinedSavedRoom) {
            long ageMs = System.currentTimeMillis() - r.lastSavedAt;
            if (ageMs > 0 && stateOut != null) {
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
        synchronized (r.queue) { welcome.put("queue", new ArrayList<>(r.queue)); }
        welcome.put("role", role);
        welcome.put("lastSavedAt", r.lastSavedAt);
        conn.send(welcome);

        broadcastPresence(r, conn, false);
        broadcast(r, Json.map("type", "system", "text", name + " دخل الغرفة 👋"), null);
        sendMembers(r);
        if (isOwner) persist();
    }

    private void handleState(WsConnection conn, String roomId, Map<String, Object> msg) {
        Room r = room(roomId);
        Map<String, Object> state = Json.asMap(msg.get("state"));
        if (state == null) return;
        String selfId = Json.str(conn.attrs, "clientId", conn.getId());
        String name = Json.str(conn.attrs, "name", "مضيف");
        Map<String, Object> stored;
        synchronized (r) {
            String role = Json.str(conn.attrs, "role", "viewer");
            if (!"owner".equals(role) && !"organizer".equals(role)) {
                conn.send(Json.map("type", "error", "code", "permission", "action", "state", "message", "التحكم متاح لمنشئ الغرفة والمنظّمين فقط", "state", r.state));
                return;
            }
            long rev = r.rev.incrementAndGet();
            long now = System.currentTimeMillis();
            stored = new LinkedHashMap<>(state);
            stored.put("rev", rev);
            stored.put("t", now);
            stored.put("hostId", selfId);
            stored.put("hostName", name);
            stored.put("updatedBy", selfId);
            stored.put("updatedByName", name);
            r.state = stored;
            r.hostId = selfId;
            r.hostName = name;
            r.lastSavedAt = now;
            conn.attrs.put("lastSeen", now);
            broadcast(r, Json.map("type", "state", "state", stored, "sender", selfId), null);
        }
    }

    private void handleChat(WsConnection conn, String roomId, Map<String, Object> msg) {
        Room r = room(roomId);
        Map<String, Object> m = Json.asMap(msg.get("message"));
        if (m == null) return;

        /* strip() removes whitespace without destroying the U+0001 chat metadata marker.
           String.trim() also removes control characters, breaking replies and reactions. */
        String text = Json.str(m, "text", "").strip();
        if (text.isEmpty()) return;
        if (text.length() > 1000) text = text.substring(0, 1000);

        Map<String, Object> stored = new LinkedHashMap<>();
        stored.put("id", "s-" + System.nanoTime());
        stored.put("name", Json.str(conn.attrs, "name", "زائر"));
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
        if (name.length() > 30) name = name.substring(0, 30);
        String clientId = Json.str(conn.attrs, "clientId", "");
        String role = Json.str(conn.attrs, "role", "viewer");
        conn.attrs.put("name", name);
        conn.attrs.put("host", "owner".equals(role));
        conn.attrs.put("lastSeen", System.currentTimeMillis());
        RoomMember info = r.memberInfo.get(clientId);
        if (info != null) info.name = name;
        if ("owner".equals(role)) { r.hostId = clientId; r.hostName = name; }

        broadcastPresence(r, conn, false);
        sendMembers(r);
    }

    private void handleTyping(WsConnection conn, String roomId, Map<String, Object> msg) {
        Room r = room(roomId);
        conn.attrs.put("lastSeen", System.currentTimeMillis());
        broadcast(r, Json.map("type", "typing",
                "clientId", Json.str(conn.attrs, "clientId", ""),
                "name", Json.str(conn.attrs, "name", "زائر")), conn);
    }

    private void handleSetRole(WsConnection conn, String roomId, Map<String, Object> msg) {
        Room r = room(roomId);
        if (!"owner".equals(Json.str(conn.attrs, "role", "viewer"))) {
            conn.send(Json.map("type", "error", "code", "permission", "message", "إدارة المنظّمين متاحة لمنشئ الغرفة فقط"));
            return;
        }
        String target = Json.str(msg, "target", "");
        String role = Json.str(msg, "role", "viewer");
        if (target.isEmpty() || (!"organizer".equals(role) && !"viewer".equals(role))) {
            conn.send(Json.map("type", "error", "message", "طلب الدور غير صالح"));
            return;
        }
        RoomMember member = r.memberInfo.get(target);
        if (member == null || "owner".equals(member.role)) {
            conn.send(Json.map("type", "error", "message", "المشارك غير موجود أو لا يمكن تغيير دوره"));
            return;
        }
        synchronized (r) {
            member.role = role;
            for (WsConnection c : r.members) {
                if (target.equals(c.attrs.get("clientId"))) {
                    c.attrs.put("role", role);
                    c.attrs.put("host", Boolean.FALSE);
                }
            }
            broadcast(r, Json.map("type", "roles", "roles", memberList(r)), null);
            sendMembers(r);
        }
        persist();
    }

    private void handleQueue(WsConnection conn, String roomId, Map<String, Object> msg) {
        Room r = room(roomId);
        String clientId = Json.str(conn.attrs, "clientId", "");
        String action = Json.str(msg, "action", "");
        List<Map<String, Object>> updated;
        synchronized (r) {
            String role = Json.str(conn.attrs, "role", "viewer");
            synchronized (r.queue) {
                if ("add".equals(action)) {
                    Map<String, Object> input = Json.asMap(msg.get("item"));
                    String url = input == null ? "" : Json.str(input, "url", "");
                    String title = input == null ? "فيديو" : Json.str(input, "title", "فيديو");
                    if (!url.matches("(?i)^https?://.{1,2000}$")) {
                        conn.send(Json.map("type", "error", "message", "رابط الفيديو غير صالح"));
                        return;
                    }
                    if (r.queue.size() >= 100) {
                        conn.send(Json.map("type", "error", "message", "قائمة التشغيل ممتلئة"));
                        return;
                    }
                    Map<String, Object> item = Json.map(
                            "id", r.queueSeq.incrementAndGet(), "url", url, "title", title.length() > 120 ? title.substring(0, 120) : title,
                            "addedByClient", clientId, "addedBy", Json.str(conn.attrs, "name", "مشارك"), "createdAt", System.currentTimeMillis());
                    r.queue.add(item);
                } else if ("remove".equals(action)) {
                    String id = String.valueOf(msg.get("id"));
                    Map<String, Object> target = null;
                    for (Map<String, Object> item : r.queue) {
                        if (id.equals(String.valueOf(item.get("id")))) { target = item; break; }
                    }
                    if (target == null) {
                        conn.send(Json.map("type", "error", "message", "العنصر غير موجود"));
                        return;
                    }
                    String addedBy = String.valueOf(target.get("addedByClient"));
                    if (!"owner".equals(role) && !"organizer".equals(role) && !clientId.equals(addedBy)) {
                        conn.send(Json.map("type", "error", "code", "permission", "message", "يمكنك حذف ما أضفته فقط"));
                        return;
                    }
                    r.queue.remove(target);
                } else {
                    conn.send(Json.map("type", "error", "message", "طلب قائمة التشغيل غير صالح"));
                    return;
                }
                updated = new ArrayList<>(r.queue);
            }
        }
        broadcast(r, Json.map("type", "queue", "items", updated), null);
        persist();
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

        /* آخر من تحكّم غادر؛ تبقى الصلاحية محصورة بالمنشئ والمنظّمين. */
        Object clientId = conn.attrs.get("clientId");
        if (clientId != null && clientId.equals(r.hostId)) {
            r.hostId = null;
            r.hostName = null;
            broadcast(r, Json.map("type", "system",
                    "text", "غادر آخر من تحكّم — تبقى الصلاحية للمنشئ والمنظّمين"), null);
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
        m.put("role", Json.str(conn.attrs, "role", "viewer"));
        m.put("left", left);
        broadcast(r, m, left ? null : conn);
    }

    private void sendMembers(Room r) {
        List<Map<String, Object>> list = memberList(r);
        broadcast(r, Json.map("type", "members", "members", list), null);
        broadcast(r, Json.map("type", "roles", "roles", list), null);
    }

    private List<Map<String, Object>> memberList(Room r) {
        List<Map<String, Object>> list = new ArrayList<>();
        for (WsConnection c : r.members) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.attrs.get("clientId"));
            m.put("name", c.attrs.get("name"));
            m.put("host", Boolean.TRUE.equals(c.attrs.get("host")));
            m.put("role", Json.str(c.attrs, "role", "viewer"));
            list.add(m);
        }
        list.sort((a, b) -> {
            int rankA = "owner".equals(a.get("role")) ? 0 : "organizer".equals(a.get("role")) ? 1 : 2;
            int rankB = "owner".equals(b.get("role")) ? 0 : "organizer".equals(b.get("role")) ? 1 : 2;
            return Integer.compare(rankA, rankB);
        });
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
                /* Claimed rooms belong to the persistent lobby, even before the first viewer joins. */
                if (r.members.isEmpty() && (r.ownerTokenHash == null || r.ownerTokenHash.isEmpty())
                        && now - Math.max(r.createdAt, lastActivity(r)) > 600_000) rooms.remove(e.getKey(), r);
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
