package com.watchtogether;

import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.net.URI;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;

/**
 * سياسة المصادر (CORS) لنقاط /api و /healthz
 * ------------------------------------------------------------
 * الحالة الأولى (الافتراضية): الموقع والسيرفر على **نفس النطاق**
 *   (تشغيل محلي، أو Render يخدم الموقع كاملاً) → لا يوجد Origin،
 *   أو Origin يطابق Host → مسموح دائماً.
 *
 * الحالة الثانية: **الموقع على استضافة ثابتة** (GitHub Pages مثلاً)
 *   والسيرفر على Render لخدمتَي «البحث» و«الاستخراج» فقط.
 *   هنا Origin ≠ Host، فنحتاج قائمة مصادر مسموحة:
 *
 *     WT_ALLOWED_ORIGINS=https://taharbn12.github.io,https://example.com
 *     WT_ALLOWED_ORIGINS=*            للسماح للجميع (للتجربة فقط)
 *
 * لماذا لم نكتفِ بـ Access-Control-Allow-Origin: * ؟
 *   لأن نقاطنا ترفض أصلاً أي طلب من مصدر مختلف (403)، وترويسة CORS
 *   وحدها لا تمنع تنفيذ الطلب، بل تسمح للمتصفح بقراءة الرد فقط.
 */
public final class Origins {

    private Origins() { }

    /** هل يُسمح لهذا المصدر باستخدام النقطة؟ */
    public static boolean allowed(HttpExchange ex) {
        String origin = ex.getRequestHeaders().getFirst("Origin");
        if (origin == null || origin.trim().isEmpty()) return true;      /* curl / أدوات سطر الأوامر */
        if ("null".equals(origin.trim())) return allowAll();             /* ملف محلي (file://) */
        String host = ex.getRequestHeaders().getFirst("Host");
        if (host != null && !host.isEmpty() && sameAuthority(origin, host)) return true;
        return allowAll() || list().contains(origin.trim());
    }

    public static boolean allowAll() {
        String raw = System.getenv("WT_ALLOWED_ORIGINS");
        if (raw == null) return false;
        String v = raw.trim();
        if (v.equals("*") || v.equalsIgnoreCase("true")) return true;
        for (String part : v.split(",")) if (part.trim().equals("*")) return true;
        return false;
    }

    private static Set<String> list() {
        String raw = System.getenv("WT_ALLOWED_ORIGINS");
        if (raw == null || raw.trim().isEmpty()) return Collections.emptySet();
        Set<String> out = new HashSet<>();
        for (String part : raw.split(",")) {
            String v = part.trim().replaceAll("/+$", "");
            if (!v.isEmpty() && !v.equals("*")) out.add(v.toLowerCase(Locale.ROOT));
        }
        return out;
    }

    private static boolean sameAuthority(String origin, String host) {
        try {
            return Objects.equals(URI.create(origin).getRawAuthority(), host);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * ترويسات CORS للرد. نُعيد المصدر نفسه (لا *) لأن الردود قد تُقرأ
     * باعتماديات، ولا نريد فتحها للجميع إن كانت هناك قائمة محدّدة.
     */
    public static void apply(HttpExchange ex, String methods) {
        String origin = ex.getRequestHeaders().getFirst("Origin");
        if (origin == null || origin.trim().isEmpty()) {
            ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        } else {
            ex.getResponseHeaders().set("Access-Control-Allow-Origin", origin.trim());
            ex.getResponseHeaders().set("Vary", "Origin");
        }
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", methods);
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
        ex.getResponseHeaders().set("Access-Control-Max-Age", "600");
    }

    /** ردّ الطلب التمهيدي (preflight) — يُرجع true إن كان الطلب OPTIONS وتم الرد عليه */
    public static boolean preflight(HttpExchange ex, String methods) throws IOException {
        if (!"OPTIONS".equals(ex.getRequestMethod())) return false;
        apply(ex, methods);
        ex.sendResponseHeaders(204, -1);
        return true;
    }

    /** رسالة الرفض الموحّدة */
    public static String denyMessage() {
        return "طلب من مصدر غير مسموح — أضف نطاق الموقع إلى WT_ALLOWED_ORIGINS على السيرفر";
    }
}
