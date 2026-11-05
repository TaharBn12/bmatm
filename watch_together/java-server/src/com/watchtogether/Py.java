package com.watchtogether;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * اختيار مترجم Python المناسب لتشغيل yt-dlp.
 *
 * على لينكس/ماك الاسم المعتاد هو python3، أما على ويندوز فالأسماء الممكنة
 * هي python أو py -3. إن لم نجرّبها بالترتيب تفشل كل خدمات yt-dlp على
 * ويندوز برسالة «خدمة الاستخراج غير متاحة» دون سبب واضح في السجل.
 *
 * يمكن تجاوز الاختيار تماماً بمتغير البيئة WT_PYTHON (مثال: WT_PYTHON=python).
 */
final class Py {

    private static volatile String[] chosen = null;

    /** مقدّمة الأمر: {python3} أو {python} أو {py, -3} */
    static String[] cmd() {
        if (chosen != null) return chosen;
        synchronized (Py.class) {
            if (chosen != null) return chosen;
            List<String[]> candidates = new ArrayList<>();
            String env = System.getenv("WT_PYTHON");
            if (env != null && !env.trim().isEmpty()) candidates.add(env.trim().split("\\s+"));
            candidates.add(new String[] { "python3" });
            candidates.add(new String[] { "python" });
            candidates.add(new String[] { "py", "-3" });
            for (String[] c : candidates) {
                if (works(c)) { chosen = c; return chosen; }
            }
            chosen = new String[] { "python3" };      /* الافتراضي السابق إن لم يعمل شيء */
            return chosen;
        }
    }

    /** يبني أمر yt-dlp كاملاً: <python> -m yt_dlp <المعاملات> */
    static List<String> ytDlp(List<String> tail) {
        List<String> cmd = new ArrayList<>(Arrays.asList(cmd()));
        cmd.add("-m");
        cmd.add("yt_dlp");
        cmd.addAll(tail);
        return cmd;
    }

    /**
     * سطر تشخيصي يُطبع عند إقلاع السيرفر: أي مترجم سيُستخدم، وهل yt-dlp متاح.
     * الهدف: أن يعرف المشغّل من اللحظة الأولى إن كانت /api/resolve و /api/suggest
     * ستعملان، بدل أن يكتشف ذلك بعد تجربة فاشلة.
     */
    static String report() {
        String exe = String.join(" ", cmd());
        boolean ok = runs(ytDlp(Arrays.asList("--version")));
        return "  Python      : " + exe +
            (ok ? "  ✓ yt-dlp متاح"
                : "  ⚠ yt-dlp غير مثبت — /api/resolve و /api/suggest لن يعملا" +
                  System.lineSeparator() + "                 ثبّته: python -m pip install -U yt-dlp" +
                  "  (أو اضبط WT_PYTHON)");
    }

    private static boolean works(String[] c) {
        List<String> args = new ArrayList<>(Arrays.asList(c));
        args.add("--version");
        return runs(args);
    }

    private static boolean runs(List<String> args) {
        try {
            Process p = new ProcessBuilder(args)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start();
            return p.waitFor(8, TimeUnit.SECONDS) && p.exitValue() == 0;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private Py() { }
}
