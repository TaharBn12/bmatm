package com.watchtogether;

import java.io.File;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpContext;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpPrincipal;
import com.sun.net.httpserver.HttpServer;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Optional JDK-only regression for the persistent public lobby. */
public final class RoomCatalogueCheck {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    /** In-memory streams test catalogue snapshots, not the existing HTTP/WebSocket upgrade. */
    private static final class MemoryExchange extends HttpExchange {
        private final Headers headers = new Headers();
        public Headers getRequestHeaders() { return headers; }
        public Headers getResponseHeaders() { return headers; }
        public URI getRequestURI() { return URI.create("/ws"); }
        public String getRequestMethod() { return "GET"; }
        public HttpContext getHttpContext() { return null; }
        public void close() { }
        public InputStream getRequestBody() { return new ByteArrayInputStream(new byte[0]); }
        public OutputStream getResponseBody() { return new ByteArrayOutputStream(); }
        public void sendResponseHeaders(int code, long length) { }
        public InetSocketAddress getRemoteAddress() { return new InetSocketAddress(0); }
        public int getResponseCode() { return 101; }
        public InetSocketAddress getLocalAddress() { return new InetSocketAddress(0); }
        public String getProtocol() { return "HTTP/1.1"; }
        public Object getAttribute(String key) { return null; }
        public void setAttribute(String key, Object value) { }
        public void setStreams(InputStream in, OutputStream out) { }
        public HttpPrincipal getPrincipal() { return null; }
    }

    private static void checkVerifiedAccountIdentity() throws Exception {
        final String accountId = "77777777-7777-4777-8777-777777777777";
        final String accessToken = "verified-account-access-token";
        final String secondAccessToken = "second-verified-account-token";
        final AtomicInteger authCalls = new AtomicInteger();
        final AtomicInteger goodKeyCalls = new AtomicInteger();
        HttpServer auth = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        auth.createContext("/auth/v1/user", exchange -> {
            authCalls.incrementAndGet();
            boolean keyOk = "test-anon-key".equals(exchange.getRequestHeaders().getFirst("apikey"));
            if (keyOk) goodKeyCalls.incrementAndGet();
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            boolean valid = keyOk && (("Bearer " + accessToken).equals(authorization)
                    || ("Bearer " + secondAccessToken).equals(authorization));
            byte[] body = (valid ? "{\"id\":\"" + accountId + "\"}" : "{\"message\":\"invalid token\"}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(valid ? 200 : 401, body.length);
            try (OutputStream out = exchange.getResponseBody()) { out.write(body); }
        });
        auth.start();

        Path directory = Files.createTempDirectory("wt-identity-");
        RoomStore store = new RoomStore(directory.resolve("rooms.json").toFile(),
                new SupabaseIdentityVerifier("http://127.0.0.1:" + auth.getAddress().getPort(), "test-anon-key"));
        WebSocketServer sockets = new WebSocketServer(store);
        try {
            store.createRoom("AUTH1", "غرفة تحقق", "", "a".repeat(64));
            WebSocketServer.WsConnection first = sockets.new WsConnection(new MemoryExchange());
            store.onMessage(first, Json.stringify(Json.map("type", "join", "room", "AUTH1", "client", "tab-one",
                    "name", "حساب", "memberToken", "b".repeat(64), "accessToken", accessToken,
                    "userId", "88888888-8888-4888-8888-888888888888")));
            String verifiedKey = String.valueOf(first.attrs.get("userKey"));
            check(!verifiedKey.isEmpty(), "Valid access token creates a room-scoped identity key");

            WebSocketServer.WsConnection second = sockets.new WsConnection(new MemoryExchange());
            store.onMessage(second, Json.stringify(Json.map("type", "join", "room", "AUTH1", "client", "tab-two",
                    "name", "حساب", "memberToken", "c".repeat(64), "accessToken", secondAccessToken,
                    "userId", "99999999-9999-4999-8999-999999999999")));
            check(verifiedKey.equals(second.attrs.get("userKey")), "Distinct valid tokens for one account resolve to the same room-scoped identity");
            check(authCalls.get() == 2 && goodKeyCalls.get() == 2, "Each distinct bearer token is server-verified with the configured anon key");

            WebSocketServer.WsConnection third = sockets.new WsConnection(new MemoryExchange());
            store.onMessage(third, Json.stringify(Json.map("type", "join", "room", "AUTH1", "client", "tab-three",
                    "name", "حساب", "memberToken", "e".repeat(64), "accessToken", accessToken)));
            check(verifiedKey.equals(third.attrs.get("userKey")) && authCalls.get() == 2,
                    "A repeated verified token reuses the bounded identity cache");

            String viewerUrl = "https://media.example/viewer.webm";
            store.onMessage(first, Json.stringify(Json.map("type", "state", "room", "AUTH1",
                    "state", Json.map("url", viewerUrl, "playing", true, "pos", 15))));
            check(viewerUrl.equals(store.publicRooms().get(0).get("videoUrl")),
                    "A joined viewer can publish playback state without an owner/organizer role");
            WebSocketServer.WsConnection outsider = sockets.new WsConnection(new MemoryExchange());
            store.onMessage(outsider, Json.stringify(Json.map("type", "state", "room", "AUTH1",
                    "state", Json.map("url", "https://media.example/outsider.webm", "playing", true, "pos", 30))));
            check(viewerUrl.equals(store.publicRooms().get(0).get("videoUrl")),
                    "A connection without room membership cannot publish playback state");

            WebSocketServer.WsConnection forged = sockets.new WsConnection(new MemoryExchange());
            store.onMessage(forged, Json.stringify(Json.map("type", "join", "room", "AUTH1", "client", "forged-tab",
                    "name", "انتحال", "memberToken", "d".repeat(64), "accessToken", "invalid-access-token",
                    "userId", accountId)));
            check("".equals(forged.attrs.get("userKey")), "A claimed user id without a valid token is ignored");
            check(((Number) store.publicRooms().get(0).get("participantCount")).intValue() == 2,
                    "Verified multi-tab account is counted once; unverifiable connection falls back to client id");
        } finally {
            sockets.shutdown();
            store.shutdown();
            auth.stop(0);
            Files.deleteIfExists(directory.resolve("rooms.json"));
            Files.deleteIfExists(directory.resolve("rooms.json.tmp"));
            Files.deleteIfExists(directory);
        }
    }

    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("wt-catalogue-");
        File file = directory.resolve("rooms.json").toFile();
        String secret = "a".repeat(64);
        RoomStore store = new RoomStore(file);
        try {
            Map<String, Object> created = store.createRoom("CHECK1", "غرفة شخصية", "", secret);
            check("غرفة شخصية".equals(created.get("title")), "Unicode title");
            check("everyone".equals(created.get("controlMode")), "New rooms share playback control with all joined members");
            check(created.size() == 8 && !Json.stringify(created).contains(secret), "Public fields only");
            Map<String, Object> legacySetting = store.updateRoom("CHECK1", secret, Json.map("controlMode", "owner"));
            check("everyone".equals(legacySetting.get("controlMode")), "Legacy settings cannot re-enable owner-only playback");
            store.createRoom("CHECK1", "غرفة شخصية", "", secret); // idempotent retry
            check(store.publicRooms().size() == 1, "No duplicate room");
            try {
                store.createRoom("CHECK1", "تغيير المالك", "", "b".repeat(64));
                throw new AssertionError("Another owner was accepted");
            } catch (IllegalStateException expected) { }
            try {
                store.createRoom("CHECK2", "رابط مرفوض", "javascript:alert(1)", secret);
                throw new AssertionError("Unsafe URL was accepted");
            } catch (IllegalArgumentException expected) { }
            Method getRoom = RoomStore.class.getDeclaredMethod("room", String.class);
            getRoom.setAccessible(true);
            RoomStore.Room room = (RoomStore.Room) getRoom.invoke(store, "CHECK1");
            WebSocketServer sockets = new WebSocketServer(store);
            try {
                long now = System.currentTimeMillis();
                for (int i = 0; i < 14; i++) {
                    WebSocketServer.WsConnection connection = sockets.new WsConnection(new MemoryExchange());
                    connection.attrs.put("clientId", "person-" + (i == 13 ? 0 : i)); // one duplicate connection id
                    connection.attrs.put("userKey", i == 0 || i == 1 || i == 13 ? "account-a" : "account-" + i);
                    connection.attrs.put("name", "منضم " + i);
                    connection.attrs.put("memberToken", "private-connection-secret");
                    connection.attrs.put("lastSeen", i == 11 ? now - 20000 : now);
                    if (i == 12) connection.close(1000, "closed");
                    room.members.add(connection);
                }
                Map<String, Object> live = store.publicRooms().get(0);
                check(((Number) live.get("participantCount")).intValue() == 10, "Fresh accounts count once across distinct connections");
                check(((List<?>) live.get("participants")).size() == 5, "Only five avatars are public");
                check(!Json.stringify(live).contains("private-connection-secret"), "No connection secrets in public presence");
                room.state = Json.map("url", "https://media.example/current.webm");
                check("https://media.example/current.webm".equals(store.publicRooms().get(0).get("videoUrl")), "Preview follows current video");
                room.state = null;
                room.members.clear();
                check(((Number) store.publicRooms().get(0).get("participantCount")).intValue() == 0, "Departed members are not historical attendance");
            } finally { sockets.shutdown(); }
            Method sweep = RoomStore.class.getDeclaredMethod("sweep");
            sweep.setAccessible(true);
            sweep.invoke(store);
            check(store.publicRooms().size() == 1, "An empty created room must survive cleanup before first join");
        } finally { store.shutdown(); }
        String persisted = Files.readString(file.toPath(), StandardCharsets.UTF_8);
        check(!persisted.contains(secret), "Raw owner token must not be persisted");
        RoomStore restored = new RoomStore(file);
        try {
            List<Map<String, Object>> rooms = restored.publicRooms();
            check(rooms.size() == 1 && "غرفة شخصية".equals(rooms.get(0).get("title")), "Catalogue survives restart");
            check("".equals(rooms.get(0).get("videoUrl")), "Empty rooms survive restart");
            check(((Number) rooms.get(0).get("participantCount")).intValue() == 0, "Presence is not persisted across restart");
        } finally { restored.shutdown(); }
        Files.deleteIfExists(file.toPath());
        Files.deleteIfExists(directory.resolve("rooms.json.tmp"));
        Files.deleteIfExists(directory);
        checkVerifiedAccountIdentity();
        System.out.println("Java catalogue: live account deduplication, verified identity, current video, privacy, ownership, cleanup and restart passed");
    }
}
