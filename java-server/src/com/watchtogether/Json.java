package com.watchtogether;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * محلّل ومُنسّق JSON صغير بدون أي مكتبات خارجية.
 * يكفي لبروتوكول المزامنة والدردشة في WatchTogether.
 *
 * القيم المدعومة: Map<String,Object>, List<Object>, String, Double/Long, Boolean, null
 */
public final class Json {

    private Json() {}

    /* =========================================================
       التحليل (parse)
       ========================================================= */
    public static Object parse(String s) {
        if (s == null) return null;
        Parser p = new Parser(s);
        p.skipWs();
        Object v = p.value();
        p.skipWs();
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String s) {
        Object v = parse(s);
        return (v instanceof Map) ? (Map<String, Object>) v : null;
    }

    private static final class Parser {
        private final String src;
        private int i;

        Parser(String src) { this.src = src; }

        void skipWs() {
            while (i < src.length()) {
                char c = src.charAt(i);
                if (c == ' ' || c == '\n' || c == '\r' || c == '\t') i++;
                else break;
            }
        }

        Object value() {
            skipWs();
            if (i >= src.length()) throw err("نهاية غير متوقعة");
            char c = src.charAt(i);
            switch (c) {
                case '{': return object();
                case '[': return array();
                case '"': return string();
                case 't': expect("true");  return Boolean.TRUE;
                case 'f': expect("false"); return Boolean.FALSE;
                case 'n': expect("null");  return null;
                default:  return number();
            }
        }

        void expect(String lit) {
            if (!src.startsWith(lit, i)) throw err("كلمة غير متوقعة عند " + i);
            i += lit.length();
        }

        Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++; // {
            skipWs();
            if (peek() == '}') { i++; return m; }
            while (true) {
                skipWs();
                String key = string();
                skipWs();
                if (peek() != ':') throw err("متوقع : بعد المفتاح");
                i++;
                m.put(key, value());
                skipWs();
                char c = peek();
                if (c == ',') { i++; continue; }
                if (c == '}') { i++; return m; }
                throw err("متوقع , أو } داخل كائن");
            }
        }

        List<Object> array() {
            List<Object> list = new ArrayList<>();
            i++; // [
            skipWs();
            if (peek() == ']') { i++; return list; }
            while (true) {
                list.add(value());
                skipWs();
                char c = peek();
                if (c == ',') { i++; continue; }
                if (c == ']') { i++; return list; }
                throw err("متوقع , أو ] داخل مصفوفة");
            }
        }

        String string() {
            if (peek() != '"') throw err("متوقع نص");
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < src.length()) {
                char c = src.charAt(i++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    if (i >= src.length()) break;
                    char e = src.charAt(i++);
                    switch (e) {
                        case '"':  sb.append('"');  break;
                        case '\\': sb.append('\\'); break;
                        case '/':  sb.append('/');  break;
                        case 'b':  sb.append('\b'); break;
                        case 'f':  sb.append('\f'); break;
                        case 'n':  sb.append('\n'); break;
                        case 'r':  sb.append('\r'); break;
                        case 't':  sb.append('\t'); break;
                        case 'u':
                            if (i + 4 <= src.length()) {
                                sb.append((char) Integer.parseInt(src.substring(i, i + 4), 16));
                                i += 4;
                            }
                            break;
                        default: sb.append(e);
                    }
                } else {
                    sb.append(c);
                }
            }
            throw err("نص غير مُغلق");
        }

        Object number() {
            int start = i;
            if (peek() == '-' || peek() == '+') i++;
            boolean isFloat = false;
            while (i < src.length()) {
                char c = src.charAt(i);
                if (c >= '0' && c <= '9') { i++; continue; }
                if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { isFloat = true; i++; continue; }
                break;
            }
            String num = src.substring(start, i);
            if (num.isEmpty()) throw err("رقم غير صالح عند " + start);
            try {
                if (isFloat) return Double.parseDouble(num);
                long l = Long.parseLong(num);
                if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) return (double) l; // نبقي النوع موحّداً
                return (double) l;
            } catch (NumberFormatException e) {
                throw err("رقم غير صالح: " + num);
            }
        }

        char peek() {
            if (i >= src.length()) throw err("نهاية غير متوقعة");
            return src.charAt(i);
        }

        RuntimeException err(String msg) { return new IllegalArgumentException("JSON: " + msg); }
    }

    /* =========================================================
       التنسيق (stringify)
       ========================================================= */
    public static String stringify(Object v) {
        StringBuilder sb = new StringBuilder(128);
        write(sb, v, 0);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder sb, Object v, int depth) {
        if (depth > 40) { sb.append("null"); return; }
        if (v == null) { sb.append("null"); return; }
        if (v instanceof String) { writeString(sb, (String) v); return; }
        if (v instanceof Boolean) { sb.append(((Boolean) v) ? "true" : "false"); return; }
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) { sb.append("null"); return; }
            if (d == Math.floor(d) && Math.abs(d) < 1e15) sb.append(Long.toString((long) d));
            else sb.append(Double.toString(d));
            return;
        }
        if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue(), depth + 1);
            }
            sb.append('}');
            return;
        }
        if (v instanceof Iterable) {
            sb.append('[');
            boolean first = true;
            for (Object o : (Iterable<Object>) v) {
                if (!first) sb.append(',');
                first = false;
                write(sb, o, depth + 1);
            }
            sb.append(']');
            return;
        }
        if (v instanceof Object[]) {
            sb.append('[');
            Object[] arr = (Object[]) v;
            for (int k = 0; k < arr.length; k++) {
                if (k > 0) sb.append(',');
                write(sb, arr[k], depth + 1);
            }
            sb.append(']');
            return;
        }
        writeString(sb, v.toString());
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int k = 0; k < s.length(); k++) {
            char c = s.charAt(k);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                case '\b': sb.append("\\b");  break;
                case '\f': sb.append("\\f");  break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    /* =========================================================
       مساعدات
       ========================================================= */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> asMap(Object v) {
        return (v instanceof Map) ? (Map<String, Object>) v : null;
    }

    public static String str(Map<String, ?> m, String key, String def) {
        if (m == null) return def;
        Object v = m.get(key);
        return v == null ? def : String.valueOf(v);
    }

    public static boolean bool(Map<String, ?> m, String key, boolean def) {
        if (m == null) return def;
        Object v = m.get(key);
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof String) return Boolean.parseBoolean((String) v);
        return def;
    }

    public static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
        return m;
    }
}
