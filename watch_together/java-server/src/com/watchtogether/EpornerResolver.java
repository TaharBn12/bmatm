package com.watchtogether;

import com.sun.net.httpserver.HttpExchange;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;

/** Same-origin, age-gated proxy for every read operation in Eporner API v2. */
public final class EpornerResolver {
    private static final String PREFIX = "/api/eporner";
    private static final String API_ROOT = "https://www.eporner.com/api/v2";
    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    private static final Semaphore SLOTS = new Semaphore(4);
    private static long windowStart = System.currentTimeMillis();
    private static int requests;

    private static final class Operation {
        final String upstreamPath;
        final Set<String> parameters;
        Operation(String upstreamPath, String... parameters) {
            this.upstreamPath = upstreamPath;
            this.parameters = Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList(parameters)));
        }
    }

    private static final Map<String, Operation> OPERATIONS = operations();

    private EpornerResolver() { }

    private static Map<String, Operation> operations() {
        Map<String, Operation> out = new LinkedHashMap<>();
        out.put("/video/search/", new Operation("/video/search/", "query", "per_page", "page", "order", "gay", "lq",
                "min_duration", "max_duration", "added_after", "added_before", "thumbsize", "thumbs", "fields", "lang", "format"));
        out.put("/video/id/", new Operation("/video/id/", "id", "thumbsize", "thumbs", "fields", "lang", "format"));
        out.put("/video/removed/", new Operation("/video/removed/", "since", "after", "per_page"));
        out.put("/video/status/", new Operation("/video/status/", "id"));
        out.put("/categories/", new Operation("/categories/"));
        out.put("/pornstars/", new Operation("/pornstars/", "page", "per_page"));
        out.put("/oembed/", new Operation("/oembed/", "url", "maxwidth", "maxheight", "format"));
        out.put("/openapi/", new Operation("/openapi/"));
        return Collections.unmodifiableMap(out);
    }

    private static synchronized boolean permit() {
        long now = System.currentTimeMillis();
        if (now - windowStart >= 60000) { windowStart = now; requests = 0; }
        return ++requests <= 60;
    }

    /**
     * All upstream paths are fixed by the OpenAPI document. The browser can only
     * select one of these operations and its documented query parameters; it can
     * never supply an upstream host or arbitrary URL.
     */
    public static void handle(HttpExchange ex) throws IOException {
        if (Origins.preflight(ex, "GET, OPTIONS")) return;
        if (!Origins.allowed(ex)) { sendError(ex, 403, Origins.denyMessage()); return; }
        if (!"GET".equals(ex.getRequestMethod())) { sendError(ex, 405, "استخدم GET مع عمليات Eporner"); return; }

        String requestPath = ex.getRequestURI().getPath();
        String operationPath = requestPath.startsWith(PREFIX) ? requestPath.substring(PREFIX.length()) : "";
        Operation operation = OPERATIONS.get(operationPath);
        if (operation == null) { sendError(ex, 404, "عملية Eporner غير معروفة"); return; }

        final Map<String, String> parameters;
        try { parameters = parseQuery(ex.getRequestURI().getRawQuery()); }
        catch (IllegalArgumentException error) { sendError(ex, 400, error.getMessage()); return; }
        if (!"1".equals(parameters.remove("adult_confirmed"))) {
            sendError(ex, 403, "تأكيد 18+ مطلوب قبل استخدام عمليات Eporner");
            return;
        }
        try { validate(operationPath, operation, parameters); }
        catch (IllegalArgumentException error) { sendError(ex, 400, error.getMessage()); return; }
        if (!permit()) { sendError(ex, 429, "تم تجاوز حد طلبات Eporner؛ انتظر دقيقة ثم أعد المحاولة"); return; }
        if (!SLOTS.tryAcquire()) { sendError(ex, 429, "خدمة Eporner مشغولة؛ أعد المحاولة بعد قليل"); return; }

        try {
            String target = API_ROOT + operation.upstreamPath + queryString(parameters);
            Response response = fetch(target, 0);
            if (response.retryAfter != null) ex.getResponseHeaders().set("Retry-After", response.retryAfter);
            send(ex, response.status, response.contentType, response.body);
        } catch (IllegalArgumentException error) {
            sendError(ex, 400, error.getMessage());
        } catch (Exception error) {
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            sendError(ex, 502, "تعذّر الاتصال بخدمة Eporner حالياً");
        } finally { SLOTS.release(); }
    }

    private static final class Response {
        final int status;
        final String contentType;
        final byte[] body;
        final String retryAfter;
        Response(int status, String contentType, byte[] body) { this(status, contentType, body, null); }
        Response(int status, String contentType, byte[] body, String retryAfter) {
            this.status = status;
            this.contentType = contentType;
            this.body = body;
            this.retryAfter = retryAfter;
        }
    }

    private static Response fetch(String address, int redirects) throws Exception {
        if (redirects > 3) throw new IOException("Too many Eporner redirects");
        URL url = new URL(address);
        validateRemote(url.toURI());
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(18000);
        connection.setRequestProperty("Accept", "application/json, text/xml;q=0.9, text/plain;q=0.8, */*;q=0.5");
        connection.setRequestProperty("User-Agent", "WatchTogether/1.0 (Eporner API v2 client)");
        try {
            int status = connection.getResponseCode();
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String location = connection.getHeaderField("Location");
                if (location == null || location.trim().isEmpty()) return new Response(status, "application/json; charset=utf-8", new byte[0]);
                URI next = url.toURI().resolve(location.trim());
                validateRemote(next);
                return fetch(next.toASCIIString(), redirects + 1);
            }
            long length = connection.getContentLengthLong();
            if (length > MAX_RESPONSE_BYTES) throw new IOException("Eporner response is too large");
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] body = input == null ? new byte[0] : readBounded(input, MAX_RESPONSE_BYTES);
            String contentType = connection.getContentType();
            if (contentType == null || contentType.trim().isEmpty()) contentType = "application/json; charset=utf-8";
            String retryAfter = connection.getHeaderField("Retry-After");
            return new Response(status, contentType, body, retryAfter);
        } finally { connection.disconnect(); }
    }

    private static byte[] readBounded(InputStream input, int max) throws IOException {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = in.read(buffer)) != -1) {
                total += count;
                if (total > max) throw new IOException("Eporner response is too large");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    private static void validateRemote(URI uri) throws IOException {
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getRawUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)) throw new IOException("Invalid Eporner redirect");
        String normalized = host.toLowerCase(Locale.ROOT);
        if (!(normalized.equals("eporner.com") || normalized.endsWith(".eporner.com")))
            throw new IOException("Redirect left Eporner domain");
    }

    private static Map<String, String> parseQuery(String raw) {
        Map<String, String> out = new LinkedHashMap<>();
        if (raw == null || raw.isEmpty()) return out;
        if (raw.length() > 8192) throw new IllegalArgumentException("معاملات طلب Eporner طويلة جداً");
        for (String pair : raw.split("&", -1)) {
            if (pair.isEmpty()) continue;
            int equals = pair.indexOf('=');
            String key = decode(equals < 0 ? pair : pair.substring(0, equals));
            String value = decode(equals < 0 ? "" : pair.substring(equals + 1));
            if (key.isEmpty() || key.length() > 40 || value.length() > 2048)
                throw new IllegalArgumentException("معامل Eporner غير صالح");
            if (out.put(key, value) != null) throw new IllegalArgumentException("لا تكرر معامل Eporner: " + key);
        }
        return out;
    }

    private static String decode(String value) {
        try { return URLDecoder.decode(value, "UTF-8"); }
        catch (Exception error) { throw new IllegalArgumentException("ترميز معاملات Eporner غير صالح"); }
    }

    private static void validate(String path, Operation operation, Map<String, String> parameters) {
        for (String key : parameters.keySet()) {
            if (!operation.parameters.contains(key)) throw new IllegalArgumentException("معامل غير معروف لهذه العملية: " + key);
        }
        if ("/video/id/".equals(path)) requireVideoId(parameters.get("id"));
        if ("/video/status/".equals(path)) {
            String ids = required(parameters, "id");
            String[] parts = ids.split(",", -1);
            if (parts.length < 1 || parts.length > 100) throw new IllegalArgumentException("أرسل من 1 إلى 100 معرّف فيديو");
            for (String id : parts) {
                if (id.trim().isEmpty()) throw new IllegalArgumentException("id يقبل معرّفات فيديو مفصولة بفواصل");
            }
        }
        if ("/oembed/".equals(path)) validateEpornerPage(required(parameters, "url"));

        if ("/video/removed/".equals(path)) {
            integer(parameters, "per_page", 1, 1000);
            String after = parameters.get("after");
            if (after != null && !after.matches("[0-9]{1,10}\\.[0-9]{1,10}"))
                throw new IllegalArgumentException("after يجب أن يكون رمز متابعة صالحاً");
        } else if ("/pornstars/".equals(path)) {
            integer(parameters, "page", 1, 100000);
            integer(parameters, "per_page", 1, 1000);
        } else if ("/oembed/".equals(path)) {
            integerMinimum(parameters, "maxwidth", 1);
            integerMinimum(parameters, "maxheight", 1);
        }
        /* Search and video/id parameters pass through so Eporner applies its
           documented defaults and clamping instead of receiving local errors. */
    }

    private static String required(Map<String, String> parameters, String name) {
        String value = parameters.get(name);
        if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException("المعامل مطلوب: " + name);
        return value.trim();
    }

    private static void requireVideoId(String id) {
        if (id == null || !id.matches("[A-Za-z0-9]{11}"))
            throw new IllegalArgumentException("معرّف فيديو Eporner يجب أن يتكون من 11 حرفاً أو رقماً");
    }

    private static void validateEpornerPage(String raw) {
        try {
            URI uri = new URI(raw.trim());
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getRawUserInfo() != null
                    || (uri.getPort() != -1 && uri.getPort() != 443))
                throw new IllegalArgumentException("رابط oEmbed يجب أن يكون HTTPS على Eporner");
            String normalized = host.toLowerCase(Locale.ROOT);
            if (!(normalized.equals("eporner.com") || normalized.endsWith(".eporner.com")))
                throw new IllegalArgumentException("رابط oEmbed يجب أن يكون على نطاق Eporner");
        } catch (java.net.URISyntaxException error) { throw new IllegalArgumentException("رابط oEmbed غير صالح"); }
    }

    private static void integer(Map<String, String> parameters, String key, long min, long max) {
        String value = parameters.get(key);
        if (value == null) return;
        BigInteger parsed = parseInteger(value, key);
        if (parsed.compareTo(BigInteger.valueOf(min)) < 0 || parsed.compareTo(BigInteger.valueOf(max)) > 0)
            throw new IllegalArgumentException(key + " خارج المجال المسموح");
    }

    private static void integerMinimum(Map<String, String> parameters, String key, long min) {
        String value = parameters.get(key);
        if (value == null) return;
        BigInteger parsed = parseInteger(value, key);
        if (parsed.compareTo(BigInteger.valueOf(min)) < 0)
            throw new IllegalArgumentException(key + " خارج المجال المسموح");
    }

    private static BigInteger parseInteger(String value, String key) {
        try { return new BigInteger(value); }
        catch (NumberFormatException error) { throw new IllegalArgumentException(key + " يجب أن يكون عدداً صحيحاً"); }
    }

    private static String queryString(Map<String, String> parameters) {
        if (parameters.isEmpty()) return "";
        StringBuilder query = new StringBuilder("?");
        for (Map.Entry<String, String> entry : parameters.entrySet()) {
            if (query.length() > 1) query.append('&');
            query.append(encode(entry.getKey())).append('=').append(encode(entry.getValue()));
        }
        return query.toString();
    }

    private static String encode(String value) {
        try { return URLEncoder.encode(value, "UTF-8"); }
        catch (Exception error) { throw new IllegalArgumentException("تعذّر ترميز طلب Eporner"); }
    }

    private static void sendError(HttpExchange ex, int status, String message) throws IOException {
        byte[] body = Json.stringify(Json.map("error", message)).getBytes(StandardCharsets.UTF_8);
        send(ex, status, "application/json; charset=utf-8", body);
    }

    private static void send(HttpExchange ex, int status, String contentType, byte[] body) throws IOException {
        ex.getResponseHeaders().set("Content-Type", contentType);
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        Origins.apply(ex, "GET, OPTIONS");
        ex.getResponseHeaders().set("Access-Control-Expose-Headers", "Retry-After");
        if (status == 204 || status == 304) { ex.sendResponseHeaders(status, -1); return; }
        ex.sendResponseHeaders(status, body.length);
        try (java.io.OutputStream output = ex.getResponseBody()) { output.write(body); }
    }
}
