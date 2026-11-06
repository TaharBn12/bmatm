# =========================================================
# WatchTogether — صورة Docker للنشر على Render
# ---------------------------------------------------------
# مرحلة 1: الترجمة بـ JDK (لا نحتاج Maven أو Gradle).
# مرحلة 2: التشغيل بـ JRE + Python + yt-dlp (للبحث والاستخراج).
#
# بناء محلي للتجربة:
#   docker build -t watchtogether .
#   docker run --rm -p 8080:10000 watchtogether
# ثم افتح: http://localhost:8080
# =========================================================

FROM eclipse-temurin:21-jdk AS build
WORKDIR /build
COPY watch_together/java-server/src ./src
RUN javac -encoding UTF-8 -d out $(find src -name '*.java') \
    && find out -name '*.class' | wc -l

# ---------------------------------------------------------
FROM eclipse-temurin:21-jre
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHONUTF8=1

# Python + yt-dlp: بدونهما تعمل الصفحات والغرف، لكن لا يعمل
# «البحث» ولا «استخراج الرابط المباشر».
# (--break-system-packages مطلوب على Debian 12+ بسبب PEP 668)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         python3 python3-pip ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && (python3 -m pip install --no-cache-dir --break-system-packages -U yt-dlp \
        || python3 -m pip install --no-cache-dir -U yt-dlp) \
    && (yt-dlp --version || python3 -m yt_dlp --version)

WORKDIR /app
COPY --from=build /build/out /app/out
COPY watch_together /app/watch_together

# PORT  : يضبطه Render تلقائياً (10000 هو المتعارف عليه).
# ROOT  : مجلد الملفات الثابتة (الموقع نفسه).
# WT_PYTHON : اسم مترجم Python الذي يستخدمه Py.java.
ENV PORT=10000 \
    HOST=0.0.0.0 \
    ROOT=/app/watch_together \
    WT_PYTHON=python3 \
    TZ=Africa/Algiers

EXPOSE 10000

HEALTHCHECK --interval=60s --timeout=15s --start-period=45s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["java", "-Dfile.encoding=UTF-8", "-cp", "out", "com.watchtogether.Main"]
