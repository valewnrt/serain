# Prepare a loaded video for the model (D61). Runs in the sandbox container of
# the job `video_compact`: without network, read-only, as nobody. ffmpeg runs
# here, the parser for foreign media, and that is why here and not while
# loading.
#
# Picture and sound (one file or two) become a small MP4: one frame per second
# (the model samples at that rate anyway), the long side at most 640 px, mono
# sound, at most the first 15 minutes. No metadata from the source.
#
# Input (stdin): one JSON line {"parts": [{"bytes": n, "kind": "av"|"v"|"a"}]},
# then the bytes of the parts. Output: one JSON line {"seconds": s, "cut": bool,
# "audio": bool}, then the MP4.
import json
import subprocess
import sys

MAX_SECONDS = 15 * 60
LIMIT = ["-hide_banner", "-loglevel", "error", "-nostdin"]


def fail(message):
    sys.stderr.write(message + "\n")
    sys.exit(2)


def main():
    stream = sys.stdin.buffer
    header = json.loads(stream.readline(4096))
    parts = header["parts"]
    if not isinstance(parts, list) or not 1 <= len(parts) <= 2:
        fail("expected one or two parts")
    paths = []
    for index, part in enumerate(parts):
        path = f"/tmp/in{index}"
        remaining = int(part["bytes"])
        with open(path, "wb") as handle:
            while remaining > 0:
                chunk = stream.read(min(remaining, 1024 * 1024))
                if not chunk:
                    fail("input shorter than announced")
                handle.write(chunk)
                remaining -= len(chunk)
        paths.append((path, part.get("kind")))

    video = next((path for path, kind in paths if kind in ("av", "v")), None)
    if video is None:
        fail("no picture in the video")
    # Separate sound if there is one; otherwise the sound of the picture file, if it has any.
    audio = next((path for path, kind in paths if kind == "a"), None)

    probe = subprocess.run(
        ["ffprobe", *LIMIT[:3], "-show_entries", "format=duration", "-of", "csv=p=0", video],
        capture_output=True,
        text=True,
        timeout=30,
    )
    try:
        seconds = float(probe.stdout.strip())
    except ValueError:
        seconds = None

    inputs = ["-i", video]
    maps = ["-map", "0:v:0"]
    if audio:
        inputs += ["-i", audio]
        maps += ["-map", "1:a:0?"]
    else:
        maps += ["-map", "0:a:0?"]
    command = [
        "ffmpeg",
        *LIMIT,
        *inputs,
        *maps,
        "-t",
        str(MAX_SECONDS),
        "-map_metadata",
        "-1",
        "-vf",
        "fps=1,scale='if(gte(iw,ih),min(640,iw),-2)':'if(gte(iw,ih),-2,min(640,ih))'",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "32",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "32k",
        "-ac",
        "1",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "/tmp/out.mp4",
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=170)
    if result.returncode != 0:
        fail(result.stderr[-500:])

    # Whether the result has sound, the code tells the model: without a sound track it makes up music otherwise (D61).
    streams = subprocess.run(
        ["ffprobe", *LIMIT[:3], "-show_entries", "stream=codec_type", "-of", "csv=p=0", "/tmp/out.mp4"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    has_audio = "audio" in streams.stdout.split()

    out = sys.stdout.buffer
    header = {"seconds": seconds, "cut": seconds is not None and seconds > MAX_SECONDS, "audio": has_audio}
    out.write((json.dumps(header) + "\n").encode("utf-8"))
    with open("/tmp/out.mp4", "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
    out.flush()


main()
