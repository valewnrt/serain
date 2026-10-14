# The one image of the sandbox (D8.7, D20, D21). Always runs with --network none,
# --read-only, --cap-drop ALL and as nobody; this file only says what is inside.
# No pip, no npm: without network there would be nothing to install anyway.

# whisper.cpp is built on the server it runs on: that way it uses its CPU
# instruction set (AVX2 on x86, NEON on ARM), and there is no foreign binary in the image.
FROM alpine:3.22 AS whisper
RUN apk add --no-cache build-base cmake git curl
RUN git clone --depth 1 --branch v1.9.4 https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build /src/build -j2 --target whisper-cli
# medium, 8-bit quantised: 823 MB. A multilingual model: the helper runs it with
# `-l auto` and reports the language it heard. Measured on 2026-09-20 with a
# real voice message: `small` misheard a time of day, `medium` gets it,
# `large-v3-turbo` too, only slower (D21). 8 instead of 5 bits since 2026-10-05:
# on the ARM server (NEON, without i8mm) the encoder takes almost twice as long
# with q5_0, for the same text.
ARG WHISPER_MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q8_0.bin
# Checksum from the download of 2026-10-05. Another model under the same
# address breaks the build instead of landing in the image silently.
ARG WHISPER_MODEL_SHA256=42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502
RUN curl -fL --retry 3 -o /model.bin "$WHISPER_MODEL_URL" \
 && echo "$WHISPER_MODEL_SHA256  /model.bin" | sha256sum -c -

# yt-dlp for videos from TikTok, Instagram and X (D61): the official zipapp,
# pure Python without dependencies, pinned with a checksum like the whisper model.
# A new release means a new version and a new checksum here; the platforms
# change, and then one is needed (deploy/README.md).
FROM alpine:3.22 AS ytdlp
RUN apk add --no-cache curl
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256=1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6
RUN curl -fL --retry 3 -o /yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp" \
 && echo "$YTDLP_SHA256  /yt-dlp" | sha256sum -c -

FROM alpine:3.22
RUN apk add --no-cache python3 nodejs ffmpeg poppler-utils imagemagick imagemagick-heic imagemagick-jpeg imagemagick-webp imagemagick-tiff libheif libstdc++ libgomp \
 && rm -rf /var/cache/apk/*
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /model.bin /opt/whisper/model.bin
COPY --from=ytdlp /yt-dlp /opt/serain-media/yt-dlp
COPY media_fetch.py video_compact.py /opt/serain-media/
USER 65534:65534
WORKDIR /tmp
