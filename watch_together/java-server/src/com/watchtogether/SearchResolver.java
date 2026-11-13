package com.watchtogether;

import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * نقطة بحث في ديليموشن:  GET /api/search?q=كلمة&limit=18
 * ------------------------------------------------------------
 *  • المصدر الأول: yt-dlp بمستخرج البحث dailymotion:search
 *    (الرابط: https://www.dailymotion.com/search/<كلمة>/videos)
 *    مع --flat-playlist حتى تكون النتيجة سريعة (نداء بحث واحد).
 *  • المصدر الثاني (إن فشل الأول): واجهة ديليموشن العامة api.dailymotion.com
 *    بلا أي مفتاح.
 *  • التحسين: الأغلفة والمدة تُجلب في نداء واحد لكل المعرّفات
 *    (videos?ids=…) لأن البحث المسرّع لا يعيدها.
 *
 *  المتصفح لا يستطيع فعل هذا بنفسه (CORS)، ولا علاقة لهذه النقطة
 *  بتشغيل الفيديو: الرابط المباشر يأتي من /api/resolve بعملية yt-dlp.
 *
 *  الأمان: الكلمة تُنظّف ويُحدّ طولها، والرابطان المستخدمان ثابتان
 *  (dailymotion.com فقط) — لا يوجد تمرير لروابط من المستخدم.
 */
public final class SearchResolver {

    private static final int MAX_LIMIT = 24;
    private static final int DEFAULT_LIMIT = 18;
    private static final String SEARCH_HOST = "https://www.dailymotion.com/search/";
    private static final String API = "https://api.dailymotion.com/videos";
    private static final String FIELDS = "%(id)s\t%(title)s\t%(webpage_url)s\t%(duration)s\t%(channel)s\t%(channel_id)s\t%(channel_url)s\t%(thumbnail)s";
    private static final String YOUTUBE_FIELDS = "%(id)s\t%(title)s\t%(url)s\t%(webpage_url)s\t%(duration)s\t%(channel)s\t%(channel_id)s\t%(channel_url)s\t%(thumbnail)s\t%(thumbnails.0.url)s";
    private static final String THUMB = "https://www.dailymotion.com/thumbnail/video/";
    private static final String DM_WATCH = "https://www.dailymotion.com/video/";
    private static final String YT_WATCH = "https://www.youtube.com/watch?v=";
    private static final String YT_THUMB = "https://i.ytimg.com/vi/";
    private static final String TT_WATCH = "https://www.tiktok.com/video/";
    private static final String TT_SEARCH = "https://www.tiktok.com/tag/";
    private static final String KICK_WATCH = "https://kick.com/";
    private static final String KICK_SEARCH = "https://kick.com/search?q=";
    private static final String TWITCH_WATCH = "https://www.twitch.tv/";
    private static final String TWITCH_SEARCH = "https://www.twitch.tv/search?term=";
    private static final String TWITCH_THUMB = "https://static-cdn.jtvnw.net/previews-ttv/live_user_";
    private static final String PF_WATCH = "https://www.pornflip.com/video/";
    private static final String PF_SEARCH = "https://www.pornflip.com/search?q=";
    private static final String PF_THUMB = "https://www.pornflip.com/thumbs/";

    private static final Semaphore SLOTS = new Semaphore(2);
    private static long windowStart = System.currentTimeMillis();
    private static int requests;

    private static synchronized boolean permit() {
        long now = System.currentTimeMillis();
        if (now - windowStart >= 60000) { windowStart = now; requests = 0; }
        return ++requests <= 20;
    }

    public static void handle(HttpExchange ex) throws IOException {
        int status = 200;
        Map<String, Object> result = new LinkedHashMap<>();
        boolean acquired = false;
        try {
            if (Origins.preflight(ex, "GET, OPTIONS")) return;    /* طلب تمهيدي من نطاق آخر */
            if (!"GET".equals(ex.getRequestMethod())) { status = 405; throw new IllegalArgumentException("استخدم GET"); }
            if (!Origins.allowed(ex)) { status = 403; throw new IllegalArgumentException(Origins.denyMessage()); }
            Map<String, String> query = params(ex.getRequestURI().getRawQuery());
            String term = clean(query.get("q"));
            int limit = intParam(query.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
            String site = (query.get("site") == null ? "" : query.get("site")).trim().toLowerCase();
            boolean youtube = site.equals("youtube") || site.equals("yt") || site.equals("يوتيوب");
            boolean tiktok = site.equals("tiktok") || site.equals("تيك");
            boolean kick = site.equals("kick");
            boolean twitch = site.equals("twitch") || site.equals("تويتش");
            boolean pornflip = site.equals("pornflip") || site.equals("بورن فليب");
            String browse = String.valueOf(query.getOrDefault("browse", "")).trim().toLowerCase();
            if (term.length() > 80) term = term.substring(0, 80);
            if (!(youtube && !browse.isEmpty()) && term.length() < 2) {
                status = 400; throw new IllegalArgumentException("اكتب كلمة بحث من حرفين على الأقل");
            }
            if (!permit()) { status = 429; throw new IllegalArgumentException("تم تجاوز حدّ البحث؛ انتظر قليلاً"); }
            acquired = SLOTS.tryAcquire();
            if (!acquired) { status = 429; throw new IllegalArgumentException("الخدمة مشغولة؛ أعد المحاولة بعد قليل"); }

            String resolvedSite = youtube ? "youtube" : tiktok ? "tiktok" : kick ? "kick" : twitch ? "twitch" : pornflip ? "pornflip" : "dailymotion";
            if (youtube && !browse.isEmpty()) {
                int offset = intParam(query.get("offset"), 0, 0, 10000);
                Map<String, Object> page = youtubeBrowse(browse, query.get("url"), offset, limit);
                result.put("query", term);
                result.put("site", "youtube");
                result.put("source", "yt-dlp");
                result.putAll(page);
            } else {
                String searchType = youtube ? String.valueOf(query.getOrDefault("type", "video")).trim().toLowerCase() : "video";
                List<Map<String, Object>> items;
                String source = "yt-dlp";
                if (youtube) {
                    items = youtubeSearch(term, limit, searchType);
                } else {
                    items = viaYtDlp(term, limit, false, tiktok, kick, twitch, pornflip);
                }
                if (items.isEmpty() && !youtube && !tiktok && !kick && !twitch && !pornflip) {
                    items = viaApi(term, limit);
                    source = "dailymotion-api";
                } else if (!items.isEmpty() && !youtube && !tiktok && !kick && !twitch && !pornflip) {
                    enrich(items);
                }
                result.put("query", term);
                result.put("site", resolvedSite);
                result.put("searchType", youtube ? searchType : "video");
                result.put("source", items.isEmpty() && (youtube || tiktok || kick || twitch || pornflip) ? "none" : source);
                result.put("count", items.size());
                result.put("items", items);
            }
        } catch (IllegalArgumentException e) {
            if (status == 200) status = 400;
            result.clear();
            result.put("error", e.getMessage());
            result.put("items", Collections.emptyList());
        } catch (Exception e) {
            status = 503;
            result.clear();
            result.put("error", "خدمة البحث غير متاحة؛ تأكد من تثبيت Python وyt-dlp على الخادم");
            result.put("items", Collections.emptyList());
        } finally {
            if (acquired) SLOTS.release();
        }
        byte[] bytes = Json.stringify(result).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        Origins.apply(ex, "GET, OPTIONS");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    /* =========================================================
       1) البحث عبر yt-dlp (مستخرج dailymotion:search)
       ========================================================= */
    private static List<Map<String, Object>> viaYtDlp(String term, int limit, boolean youtube, boolean tiktok, boolean kick, boolean twitch, boolean pornflip) {
        Path out = null;
        Process p = null;
        try {
            /* كل منصة لها رابط بحث خاص بها يُمرَّر إلى yt-dlp:
               يوتيوب: ytsearchN:كلمة
               تيك توك: صفحة الوسم tiktok.com/tag/كلمة
               كيك: kick.com/search?q=كلمة
               تويتش: twitch.tv/search?term=كلمة
               PornFlip: pornflip.com/search?q=كلمة
               ديليموشن: dailymotion.com/search/كلمة/videos */
            String search;
            if (youtube) {
                search = "ytsearch" + Math.max(1, limit) + ":" + term;
            } else if (tiktok) {
                search = TT_SEARCH + URLEncoder.encode(term, "UTF-8") + "/videos";
            } else if (kick) {
                search = KICK_SEARCH + URLEncoder.encode(term, "UTF-8");
            } else if (twitch) {
                search = TWITCH_SEARCH + URLEncoder.encode(term, "UTF-8");
            } else if (pornflip) {
                search = PF_SEARCH + URLEncoder.encode(term, "UTF-8");
            } else {
                search = SEARCH_HOST + URLEncoder.encode(term, "UTF-8") + "/videos";
            }
            out = Files.createTempFile("wt-search-", ".tsv");
            List<String> args = new ArrayList<>(Arrays.asList(
                "--ignore-config", "--no-warnings", "--socket-timeout", "10", "--retries", "1",
                "--use-extractors", "default,-generic", "--flat-playlist",
                "--playlist-end", String.valueOf(limit),
                "--print", FIELDS, "--", search));
            Path err = Files.createTempFile("wt-search-", ".err");
            /* Py.process يضمن ترميز UTF‑8 لخراج yt-dlp على ويندوز */
            p = Py.process(args).redirectOutput(out.toFile())
                                .redirectError(err.toFile()).start();
            boolean done = p.waitFor(30, TimeUnit.SECONDS);
            if (!done || p.exitValue() != 0 || Files.size(out) > 262144) {
                /* لا نصمت: سبب الفشل هو أول ما نحتاجه عند «صفر نتائج» */
                System.err.println("[search] yt-dlp " + (!done ? "تجاوز المهلة" : "أعاد الرمز " + p.exitValue())
                        + " — " + trimForLog(read(err)));
                Files.deleteIfExists(err);
                return Collections.emptyList();
            }
            Files.deleteIfExists(err);
            List<Map<String, Object>> items = new ArrayList<>();
            for (String line : read(out).split("\\R")) {
                Map<String, Object> item = fromRow(line, youtube, tiktok, kick, twitch, pornflip);
                if (item != null) items.add(item);
                if (items.size() >= limit) break;
            }
            return dedupe(items);
        } catch (Exception e) {
            return Collections.emptyList();
        } finally {
            if (p != null && p.isAlive()) p.destroyForcibly();
            if (out != null) { try { Files.deleteIfExists(out); } catch (IOException ignored) { } }
        }
    }

    /**
     * سطر من yt-dlp: id \t title \t url \t duration
     * العنوان والرابط يُبنيان من المعرّف نفسه، فلا نثق بروابط يكتبها الوسيط.
     */
    /** YouTube video search uses ytsearch; channel and playlist searches use YouTube's type filters. */
    private static List<Map<String, Object>> youtubeSearch(String term, int limit, String type) {
        if ("video".equals(type) || "videos".equals(type))
            return viaYtDlp(term, limit, true, false, false, false, false);
        if ("channel".equals(type) || "channels".equals(type)) return youtubeFilteredSearch(term, limit, "channel");
        if ("playlist".equals(type) || "playlists".equals(type)) return youtubeFilteredSearch(term, limit, "playlist");
        if (!"all".equals(type)) throw new IllegalArgumentException("نوع بحث يوتيوب غير مدعوم");

        List<List<Map<String, Object>>> groups = Arrays.asList(
            viaYtDlp(term, limit, true, false, false, false, false),
            youtubeFilteredSearch(term, limit, "channel"),
            youtubeFilteredSearch(term, limit, "playlist"));
        List<Map<String, Object>> mixed = new ArrayList<>();
        Map<String, Boolean> seen = new LinkedHashMap<>();
        for (int i = 0; mixed.size() < limit; i++) {
            boolean any = false;
            for (List<Map<String, Object>> group : groups) {
                if (i >= group.size()) continue;
                any = true;
                Map<String, Object> item = group.get(i);
                String key = String.valueOf(item.get("type")) + ":" + String.valueOf(item.get("id"));
                if (!seen.containsKey(key)) { seen.put(key, true); mixed.add(item); }
                if (mixed.size() >= limit) break;
            }
            if (!any) break;
        }
        return mixed;
    }

    private static List<Map<String, Object>> youtubeFilteredSearch(String term, int limit, String type) {
        String sp;
        if ("channel".equals(type)) sp = "EgIQAg%3D%3D";
        else if ("playlist".equals(type)) sp = "EgIQAw%3D%3D";
        else throw new IllegalArgumentException("مرشح بحث يوتيوب غير مدعوم");
        String target = "https://www.youtube.com/results?search_query=" + enc(term) + "&sp=" + sp;
        return youtubeFlat(target, 0, limit, type);
    }

    /** Flat search/tab extraction: only public YouTube URLs and metadata leave yt-dlp. */
    private static List<Map<String, Object>> youtubeFlat(String target, int offset, int limit, String resultType) {
        Path out = null;
        Path err = null;
        Process process = null;
        try {
            out = Files.createTempFile("wt-youtube-search-", ".tsv");
            err = Files.createTempFile("wt-youtube-search-", ".err");
            List<String> args = new ArrayList<>(Arrays.asList(
                "--ignore-config", "--no-warnings", "--socket-timeout", "10", "--retries", "1",
                "--use-extractors", "default,-generic", "--flat-playlist"));
            if (offset > 0) args.addAll(Arrays.asList("--playlist-start", String.valueOf(offset + 1)));
            args.addAll(Arrays.asList("--playlist-end", String.valueOf(offset + limit), "--print", YOUTUBE_FIELDS, "--", target));
            process = Py.process(args).redirectOutput(out.toFile()).redirectError(err.toFile()).start();
            boolean done = process.waitFor(35, TimeUnit.SECONDS);
            if (!done || process.exitValue() != 0 || Files.size(out) > 524288) {
                System.err.println("[search] YouTube yt-dlp " + (!done ? "تجاوز المهلة" : "أعاد الرمز " + process.exitValue())
                    + " — " + trimForLog(read(err)));
                return Collections.emptyList();
            }
            List<Map<String, Object>> items = new ArrayList<>();
            for (String line : read(out).split("\\R")) {
                Map<String, Object> item = fromYouTubeRow(line, resultType);
                if (item != null) items.add(item);
                if (items.size() >= limit) break;
            }
            return dedupeTyped(items);
        } catch (Exception error) {
            return Collections.emptyList();
        } finally {
            if (process != null && process.isAlive()) process.destroyForcibly();
            if (out != null) { try { Files.deleteIfExists(out); } catch (IOException ignored) { } }
            if (err != null) { try { Files.deleteIfExists(err); } catch (IOException ignored) { } }
        }
    }

    private static Map<String, Object> fromYouTubeRow(String line, String type) {
        if (line == null || line.trim().isEmpty()) return null;
        String[] parts = line.trim().split("\\t", -1);
        String id = col(parts, 0);
        String title = col(parts, 1);
        String rawUrl = col(parts, 2);
        String webpage = col(parts, 3);
        String author = col(parts, 5);
        String channelId = col(parts, 6);
        String channelUrl = col(parts, 7);
        String thumbnail = firstHttps(col(parts, 8), col(parts, 9));
        if (title.isEmpty()) title = "بدون عنوان";

        Map<String, Object> item = new LinkedHashMap<>();
        item.put("type", type);
        item.put("id", id);
        item.put("title", title);
        item.put("author", author);
        item.put("thumb", thumbnail);
        if ("video".equals(type)) {
            if (!isId(id, true, false, false, false, false)) return null;
            long duration = 0;
            try { duration = Long.parseLong(col(parts, 4)); } catch (Exception ignored) { }
            item.put("url", YT_WATCH + id);
            item.put("duration", duration);
            String safeChannel = safeYouTubeChannel(channelUrl);
            if (safeChannel.isEmpty()) safeChannel = safeYouTubeChannel(rawUrl);
            if (safeChannel.isEmpty()) safeChannel = safeYouTubeChannel(webpage);
            if (safeChannel.isEmpty() && channelId.matches("UC[A-Za-z0-9_-]{20,30}"))
                safeChannel = "https://www.youtube.com/channel/" + channelId;
            if (!safeChannel.isEmpty()) item.put("channelUrl", safeChannel);
            if (!channelId.isEmpty()) item.put("channelId", channelId);
            if (thumbnail.isEmpty()) item.put("thumb", YT_THUMB + id + "/hqdefault.jpg");
            return item;
        }
        if ("channel".equals(type)) {
            if (channelId.isEmpty() && id.matches("UC[A-Za-z0-9_-]{20,30}")) channelId = id;
            String safeChannel = safeYouTubeChannel(channelUrl);
            if (safeChannel.isEmpty()) safeChannel = safeYouTubeChannel(rawUrl);
            if (safeChannel.isEmpty()) safeChannel = safeYouTubeChannel(webpage);
            if (safeChannel.isEmpty() && channelId.matches("UC[A-Za-z0-9_-]{20,30}"))
                safeChannel = "https://www.youtube.com/channel/" + channelId;
            if (safeChannel.isEmpty()) return null;
            item.put("id", channelId.isEmpty() ? safeChannel : channelId);
            item.put("url", safeChannel);
            item.put("channelUrl", safeChannel);
            item.put("channelId", channelId);
            item.put("duration", 0);
            return item;
        }
        if ("playlist".equals(type)) {
            String listId = playlistId(rawUrl);
            if (listId.isEmpty()) listId = playlistId(webpage);
            if (listId.isEmpty() && id.matches("[A-Za-z0-9_-]{2,64}")) listId = id;
            if (listId.isEmpty()) return null;
            item.put("id", listId);
            item.put("url", "https://www.youtube.com/playlist?list=" + listId);
            item.put("duration", 0);
            return item;
        }
        return null;
    }

    private static String firstHttps(String first, String second) {
        String value = first != null && first.startsWith("https://") ? first : second;
        return value != null && value.startsWith("https://") ? value : "";
    }

    private static String playlistId(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        try {
            URI uri = new URI(raw);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || !isYouTubeHost(uri.getHost()) || uri.getUserInfo() != null) return "";
            String id = params(uri.getRawQuery()).getOrDefault("list", "");
            return id.matches("[A-Za-z0-9_-]{2,64}") ? id : "";
        } catch (Exception error) { return ""; }
    }

    private static boolean isYouTubeHost(String host) {
        if (host == null) return false;
        String value = host.toLowerCase();
        return value.equals("youtube.com") || value.equals("www.youtube.com") || value.equals("m.youtube.com");
    }

    private static String safeYouTubeChannel(String raw) {
        if (raw == null || raw.trim().isEmpty()) return "";
        try {
            URI uri = new URI(raw.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || !isYouTubeHost(uri.getHost()) || uri.getUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) return "";
            String path = uri.getPath();
            if (path == null) return "";
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("^/(channel/UC[A-Za-z0-9_-]{20,30}|@[A-Za-z0-9._-]{3,64}|c/[A-Za-z0-9._-]{1,64}|user/[A-Za-z0-9._-]{1,64})(?:/.*)?$").matcher(path);
            if (!m.matches()) return "";
            return "https://www.youtube.com/" + m.group(1);
        } catch (Exception error) { return ""; }
    }

    private static Map<String, Object> youtubeBrowse(String type, String rawUrl, int offset, int limit) {
        String target;
        if ("playlist".equals(type) || "playlists".equals(type)) {
            String id = playlistId(rawUrl);
            if (id.isEmpty()) throw new IllegalArgumentException("رابط قائمة تشغيل يوتيوب غير صالح");
            target = "https://www.youtube.com/playlist?list=" + id;
        } else if ("channel".equals(type) || "channels".equals(type)) {
            String channel = safeYouTubeChannel(rawUrl);
            if (channel.isEmpty()) throw new IllegalArgumentException("رابط قناة يوتيوب غير صالح");
            target = channel + "/videos";
        } else {
            throw new IllegalArgumentException("نوع التصفّح غير مدعوم");
        }
        List<Map<String, Object>> items = youtubeFlat(target, offset, limit, "video");
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("browseType", "playlist".equals(type) || "playlists".equals(type) ? "playlist" : "channel");
        result.put("browseUrl", target);
        result.put("offset", offset);
        result.put("nextOffset", offset + items.size());
        result.put("hasMore", items.size() >= limit);
        result.put("count", items.size());
        result.put("items", items);
        return result;
    }

    private static List<Map<String, Object>> dedupeTyped(List<Map<String, Object>> items) {
        Map<String, Map<String, Object>> seen = new LinkedHashMap<>();
        for (Map<String, Object> item : items) {
            String key = String.valueOf(item.get("type")) + ":" + String.valueOf(item.get("id"));
            if (!seen.containsKey(key)) seen.put(key, item);
        }
        return new ArrayList<>(seen.values());
    }

    private static Map<String, Object> fromRow(String line, boolean youtube, boolean tiktok, boolean kick, boolean twitch, boolean pornflip) {
        if (line == null) return null;
        String t = line.trim();
        if (t.isEmpty()) return null;
        String[] parts = t.split("\t", -1);
        String id = col(parts, 0);
        String title = col(parts, 1);
        long duration = 0;
        try { duration = Long.parseLong(col(parts, 3)); } catch (Exception ignored) { }
        if (id.isEmpty() || !isId(id, youtube, tiktok, kick, twitch, pornflip)) return null;
        if (title.isEmpty() || "NA".equals(title)) title = "";
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "video");
        m.put("id", id);
        m.put("title", title);
        if (youtube) {
            String channel = col(parts, 4);
            String channelId = col(parts, 5);
            String channelUrl = safeYouTubeChannel(col(parts, 6));
            String thumbnail = firstHttps(col(parts, 7), "");
            m.put("url", YT_WATCH + id);
            m.put("thumb", thumbnail.isEmpty() ? YT_THUMB + id + "/hqdefault.jpg" : thumbnail);
            m.put("duration", duration);
            m.put("author", channel);
            if (!channelId.isEmpty()) m.put("channelId", channelId);
            if (channelUrl.isEmpty() && channelId.matches("UC[A-Za-z0-9_-]{20,30}")) channelUrl = "https://www.youtube.com/channel/" + channelId;
            if (!channelUrl.isEmpty()) m.put("channelUrl", channelUrl);
        }
        else if (tiktok) { m.put("url", TT_WATCH + id); m.put("thumb", THUMB + id); }
        else if (kick) { m.put("url", KICK_WATCH + id); m.put("thumb", THUMB + id); }
        else if (twitch) { m.put("url", TWITCH_WATCH + id); m.put("thumb", TWITCH_THUMB + id + "-320x180.jpg"); }
        else if (pornflip) { m.put("url", PF_WATCH + id); m.put("thumb", PF_THUMB + id + ".jpg"); }
        else { m.put("url", DM_WATCH + id); m.put("thumb", THUMB + id); }
        if (!youtube) { m.put("duration", duration); m.put("author", ""); }
        return m;
    }

    /* =========================================================
       2) تحسين النتائج: الأغلفة والمدة وصاحب الفيديو
       ========================================================= */
    private static void enrich(List<Map<String, Object>> items) {
        StringBuilder ids = new StringBuilder();
        for (Map<String, Object> item : items) {
            String id = String.valueOf(item.get("id"));
            if (isId(id, false, false, false, false, false)) { if (ids.length() > 0) ids.append(','); ids.append(id); }
        }
        if (ids.length() == 0) return;
        Object data = httpJson(API + "?ids=" + ids + "&limit=" + Math.min(100, items.size() + 4)
                + "&fields=id,title,thumbnail_720_url,duration,owner.username", 10);
        Map<String, Map<String, Object>> byId = index(data);
        if (byId.isEmpty()) {
            data = httpJson(API + "?ids=" + ids + "&limit=" + Math.min(100, items.size() + 4)
                    + "&fields=id,title,thumbnail_720_url,duration", 10);
            byId = index(data);
        }
        if (byId.isEmpty()) return;
        for (Map<String, Object> item : items) {
            Map<String, Object> extra = byId.get(String.valueOf(item.get("id")));
            if (extra == null) continue;
            String thumb = Json.str(extra, "thumbnail_720_url", "");
            if (thumb.startsWith("https://")) item.put("thumb", thumb);
            long duration = longOf(extra.get("duration"));
            if (duration > 0) item.put("duration", duration);
            String author = Json.str(extra, "owner.username", "");
            if (author.isEmpty()) {
                Map<String, Object> owner = Json.asMap(extra.get("owner"));
                author = Json.str(owner, "username", "");
            }
            if (!author.isEmpty()) item.put("author", author);
            if (String.valueOf(item.get("title")).isEmpty()) item.put("title", Json.str(extra, "title", ""));
        }
    }

    /* =========================================================
       3) المصدر البديل: واجهة ديليموشن العامة (بلا مفتاح)
       ========================================================= */
    private static List<Map<String, Object>> viaApi(String term, int limit) {
        String url = API + "?search=" + enc(term) + "&limit=" + limit + "&sort=relevance"
                + "&fields=id,title,thumbnail_720_url,duration,owner.username";
        Object data = httpJson(url, 10);
        if (data == null) {
            data = httpJson(API + "?search=" + enc(term) + "&limit=" + limit + "&sort=relevance"
                    + "&fields=id,title,thumbnail_720_url,duration", 10);
        }
        List<Map<String, Object>> out = new ArrayList<>();
        if (data == null) return out;
        Object rawList = (data instanceof Map) ? ((Map<?, ?>) data).get("list") : null;
        if (!(rawList instanceof List)) return out;
        for (Object entry : (List<?>) rawList) {
            Map<String, Object> v = Json.asMap(entry);
            if (v == null) continue;
            String id = Json.str(v, "id", "");
            if (!isId(id, false, false, false, false, false)) continue;
            String author = Json.str(v, "owner.username", "");
            if (author.isEmpty()) author = Json.str(Json.asMap(v.get("owner")), "username", "");
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", id);
            m.put("title", Json.str(v, "title", ""));
            m.put("url", "https://www.dailymotion.com/video/" + id);
            String thumb = Json.str(v, "thumbnail_720_url", "");
            m.put("thumb", thumb.startsWith("https://") ? thumb : THUMB + id);
            m.put("duration", longOf(v.get("duration")));
            m.put("author", author);
            out.add(m);
            if (out.size() >= limit) break;
        }
        return dedupe(out);
    }

    /* =========================================================
       أدوات مشتركة
       ========================================================= */
    private static Map<String, Map<String, Object>> index(Object data) {
        Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
        if (!(data instanceof Map)) return byId;
        Object rawList = ((Map<?, ?>) data).get("list");
        if (!(rawList instanceof List)) return byId;
        for (Object entry : (List<?>) rawList) {
            Map<String, Object> v = Json.asMap(entry);
            if (v == null) continue;
            String id = Json.str(v, "id", "");
            if (!id.isEmpty()) byId.put(id, v);
        }
        return byId;
    }

    private static Object httpJson(String url, int seconds) {
        HttpURLConnection c = null;
        try {
            /* URI أولاً: بانية URL المباشرة مهملة في Java 20+ */
            c = (HttpURLConnection) new java.net.URI(url).toURL().openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(seconds * 1000);
            c.setReadTimeout(seconds * 1000);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "WatchTogether/1.0 (+java-server)");
            int code = c.getResponseCode();
            if (code != 200) return null;
            java.io.InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            int total = 0;
            while ((n = in.read(chunk)) > 0) {
                total += n;
                if (total > 262144) break;
                buf.write(chunk, 0, n);
            }
            in.close();
            return Json.parse(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static List<Map<String, Object>> dedupe(List<Map<String, Object>> items) {
        Map<String, Map<String, Object>> seen = new LinkedHashMap<>();
        for (Map<String, Object> item : items) {
            String id = String.valueOf(item.get("id"));
            if (id.isEmpty() || "null".equals(id)) continue;
            if (!seen.containsKey(id)) seen.put(id, item);
        }
        return new ArrayList<>(seen.values());
    }

    /** قراءة آمنة لملف مؤقت (لا ترمي استثناءً، وتتسامح مع أي ترميز) */
    private static String read(Path file) {
        return Py.readUtf8(file);
    }

    /** ملخّص قصير للسجل */
    private static String trimForLog(String text) {
        String t = text == null ? "" : text.replaceAll("\\s+", " ").trim();
        return t.isEmpty() ? "(بلا رسالة)" : (t.length() > 300 ? t.substring(0, 300) + "…" : t);
    }

    private static String col(String[] parts, int i) {
        if (i >= parts.length) return "";
        String v = parts[i].trim();
        return "NA".equals(v) ? "" : v;
    }

    /** معرّف يوتيوب: 11 محرفاً صارم · ديليموشن: حروف وأرقام حتى 32 · تيك توك/كيك/تويتش: أي نص غير فارغ */
    private static boolean isId(String id, boolean youtube, boolean tiktok, boolean kick, boolean twitch, boolean pornflip) {
        if (id == null) return false;
        String v = id.trim();
        if (v.isEmpty()) return false;
        if (youtube) return v.length() == 11 && v.matches("[A-Za-z0-9_-]{11}");
        if (tiktok || kick || twitch || pornflip) return true; /* أي معرف غير فارغ مقبول لهذه المنصات */
        if (v.length() > 32) return false;
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
            if (!ok) return false;
        }
        return true;
    }

    private static long longOf(Object v) {
        if (v instanceof Number) return ((Number) v).longValue();
        try { return Long.parseLong(String.valueOf(v).trim()); } catch (Exception e) { return 0; }
    }

    /** كلمة بحث نظيفة: بلا محارف تحكّم، ومسافات موحّدة */
    private static String clean(String raw) {
        if (raw == null) return "";
        StringBuilder sb = new StringBuilder();
        for (char c : raw.toCharArray()) {
            if (c < 0x20 || c == 0x7F) c = ' ';
            sb.append(c);
        }
        return sb.toString().replace('\u00A0', ' ').replaceAll("\\s+", " ").trim();
    }

    private static String enc(String value) {
        try { return URLEncoder.encode(value, "UTF-8"); } catch (Exception e) { return value; }
    }

    private static int intParam(String raw, int def, int min, int max) {
        if (raw == null) return def;
        try {
            int v = Integer.parseInt(raw.trim());
            return Math.max(min, Math.min(max, v));
        } catch (Exception e) { return def; }
    }

    private static Map<String, String> params(String rawQuery) {
        Map<String, String> out = new LinkedHashMap<>();
        if (rawQuery == null || rawQuery.isEmpty()) return out;
        for (String pair : rawQuery.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String k = eq < 0 ? pair : pair.substring(0, eq);
            String v = eq < 0 ? "" : pair.substring(eq + 1);
            try {
                out.put(java.net.URLDecoder.decode(k, "UTF-8"), java.net.URLDecoder.decode(v, "UTF-8"));
            } catch (Exception e) {
                out.put(k, v);
            }
        }
        return out;
    }

    /** يُستخدم من السيرفر فقط — لا يوجد سبب لإنشاء نسخة من هذه الفئة */
    private SearchResolver() { }
}
