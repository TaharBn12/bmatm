package com.watchtogether;

import com.sun.net.httpserver.HttpExchange;

import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * مساعد لقراءة ترويسات HTTP بأسماء صغيرة (lowercase)
 * لأن أسماء الترويسات غير حساسة لحالة الأحرف.
 */
public final class Headers {

    private Headers() {}

    public static Map<String, String> lower(HttpExchange ex) {
        Map<String, String> out = new HashMap<>();
        for (Map.Entry<String, List<String>> e : ex.getRequestHeaders().entrySet()) {
            if (e.getKey() == null) continue;
            List<String> values = e.getValue();
            if (values == null || values.isEmpty()) continue;
            out.put(e.getKey().toLowerCase(Locale.ROOT), values.get(0));
        }
        return out;
    }

    public static String get(HttpExchange ex, String name) {
        return lower(ex).get(name.toLowerCase(Locale.ROOT));
    }
}
