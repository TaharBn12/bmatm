package com.watchtogether;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Resolves the account id from a Supabase access token instead of trusting a
 * user id supplied in the WebSocket payload. The anon key is public; it is used
 * only to call Supabase Auth's /user endpoint, which verifies the bearer token.
 */
final class SupabaseIdentityVerifier {
    private static final String DEFAULT_URL = "https://cazwkhcbkzhnsluuafwz.supabase.co";
    private static final String DEFAULT_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhendraGNia3pobnNsdXVhZnd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc5NDQ3ODIsImV4cCI6MjA4MzUyMDc4Mn0.u1l9BrzI7ZA9P3CSdXN0tYkHu1TUNTGsqczByNSPUN0";
    private static final int MAX_TOKEN_LENGTH = 16_384;
    private static final long VALID_CACHE_MS = 60_000;
    private static final long INVALID_CACHE_MS = 5_000;

    private static final class CachedIdentity {
        final String userId;
        final long expiresAt;
        CachedIdentity(String userId, long expiresAt) {
            this.userId = userId;
            this.expiresAt = expiresAt;
        }
    }

    private final URI userEndpoint;
    private final String anonKey;
    private final HttpClient client;
    private final ConcurrentMap<String, CachedIdentity> cache = new ConcurrentHashMap<>();

    SupabaseIdentityVerifier(String projectUrl, String anonKey) {
        URI endpoint = null;
        String key = anonKey == null ? "" : anonKey.trim();
        try {
            String base = projectUrl == null ? "" : projectUrl.trim().replaceAll("/+$", "");
            URI parsed = URI.create(base);
            String scheme = parsed.getScheme() == null ? "" : parsed.getScheme().toLowerCase(java.util.Locale.ROOT);
            String host = parsed.getHost() == null ? "" : parsed.getHost().toLowerCase(java.util.Locale.ROOT);
            boolean localHttp = "http".equals(scheme)
                    && ("localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host));
            if (("https".equals(scheme) || localHttp)
                    && parsed.getHost() != null && parsed.getUserInfo() == null && parsed.getQuery() == null
                    && parsed.getFragment() == null && !key.isEmpty()) {
                endpoint = URI.create(base + "/auth/v1/user");
            }
        } catch (IllegalArgumentException ignored) { }
        this.userEndpoint = endpoint;
        this.anonKey = key;
        this.client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(2))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    static SupabaseIdentityVerifier fromEnvironment() {
        String url = firstNonBlank(System.getenv("WT_SUPABASE_URL"), System.getenv("SUPABASE_URL"), DEFAULT_URL);
        String key = firstNonBlank(System.getenv("WT_SUPABASE_ANON_KEY"), System.getenv("SUPABASE_ANON_KEY"), DEFAULT_ANON_KEY);
        return new SupabaseIdentityVerifier(url, key);
    }

    /** Returns a verified Supabase UUID, or an empty string when verification is unavailable. */
    String verifiedUserId(String accessToken) {
        if (userEndpoint == null || anonKey.isEmpty() || accessToken == null
                || accessToken.length() < 20 || accessToken.length() > MAX_TOKEN_LENGTH) return "";

        String cacheKey = sha256(accessToken);
        long now = System.currentTimeMillis();
        CachedIdentity cached = cache.get(cacheKey);
        if (cached != null) {
            if (cached.expiresAt > now) return cached.userId;
            cache.remove(cacheKey, cached);
        }

        String userId = "";
        try {
            HttpRequest request = HttpRequest.newBuilder(userEndpoint)
                    .timeout(Duration.ofSeconds(3))
                    .header("apikey", anonKey)
                    .header("Authorization", "Bearer " + accessToken)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = client.send(request,
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() == 200 && response.body() != null && response.body().length() <= 64 * 1024) {
                Map<String, Object> user = Json.parseObject(response.body());
                String id = user == null ? "" : Json.str(user, "id", "");
                if (id.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) {
                    userId = id.toLowerCase(java.util.Locale.ROOT);
                }
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (Exception ignored) {
            /* A temporary auth/network failure must not block room entry; it only disables account grouping. */
        }

        long ttl = userId.isEmpty() ? INVALID_CACHE_MS : VALID_CACHE_MS;
        cache.put(cacheKey, new CachedIdentity(userId, now + ttl));
        if (cache.size() > 4096) {
            cache.entrySet().removeIf(entry -> entry.getValue().expiresAt <= now);
            if (cache.size() > 4096) cache.clear();
        }
        return userId;
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) if (value != null && !value.trim().isEmpty()) return value.trim();
        return "";
    }

    private static String sha256(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) hex.append(String.format("%02x", b & 0xff));
            return hex.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 غير متوفر", e);
        }
    }
}
