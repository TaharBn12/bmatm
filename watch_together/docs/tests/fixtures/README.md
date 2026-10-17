# Playback fixture

`playback.webm` is a generated 12-second, silent VP9 test pattern (160×90, 5 fps,
approximately 25 KB). It contains no third-party media. The browser regression
suite serves it from a second local HTTP origin **without CORS headers** to test
native decoding, play/pause and seeking rather than mocking media APIs.

Regenerate with FFmpeg:

```sh
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=5 -t 12 -an \
  -c:v libvpx-vp9 -b:v 20k -y playback.webm
```

## Optional Java catalogue check

`RoomCatalogueCheck.java` is a JDK-only test for public fields, owner-token
conflicts, invalid URLs, five-avatar/live-count snapshots, current video,
empty-room cleanup and metadata persistence across a
store restart. It uses a temporary directory and deletes its data on success.
It does **not** test the Java WebSocket upgrade. Compile/run instructions are
in the project README's testing section.

## HLS preview fixture

`hls/playback.m3u8` and its four small MPEG-TS segments are an 8-second,
silent H.264 test pattern (160×90, 10 fps; approximately 50 KB total),
generated locally, with no third-party content. The browser test decodes it
both through native HLS (when available) and through bundled hls.js, and
checks that the card loops only a five-second window.

Regenerate from `watch_together/docs/tests/fixtures` with FFmpeg:

```sh
mkdir -p hls
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=10 -t 8 -an \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -b:v 32k \
  -maxrate 48k -bufsize 96k -g 20 -sc_threshold 0 \
  -hls_time 2 -hls_list_size 0 -hls_segment_filename hls/segment-%02d.ts \
  -y hls/playback.m3u8
```
