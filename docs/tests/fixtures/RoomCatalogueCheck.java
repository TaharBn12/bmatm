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
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

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

    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("wt-catalogue-");
        File file = directory.resolve("rooms.json").toFile();
        String secret = "a".repeat(64);
        RoomStore store = new RoomStore(file);
        try {
            Map<String, Object> created = store.createRoom("CHECK1", "غرفة شخصية", "", secret);
            check("غرفة شخصية".equals(created.get("title")), "Unicode title");
            check(created.size() == 6 && !Json.stringify(created).contains(secret), "Public fields only");
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
                    connection.attrs.put("clientId", "person-" + (i == 13 ? 0 : i)); // one duplicate
                    connection.attrs.put("name", "منضم " + i);
                    connection.attrs.put("memberToken", "private-connection-secret");
                    connection.attrs.put("lastSeen", i == 11 ? now - 20000 : now);
                    if (i == 12) connection.close(1000, "closed");
                    room.members.add(connection);
                }
                Map<String, Object> live = store.publicRooms().get(0);
                check(((Number) live.get("participantCount")).intValue() == 11, "Fresh, unique connections only");
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
        System.out.println("Java catalogue: current video, five avatars, exact live count, privacy, ownership, cleanup and restart passed");
    }
}
