# Fetch a video or the images of a post from TikTok, Instagram or X (D61). Runs
# in the sandbox container of the job `media_fetch`: --network none, read-only,
# as nobody. The only connection to the outside is the Unix socket of Serain's
# filter proxy, handed in under /proxy (public addresses only, ports 80 and 443
# only, src/browser/proxy.ts). yt-dlp only knows TCP proxies, so a small
# forwarder listens on loopback here and hands every connection to the socket.
#
# This only loads, it never decodes: no ffmpeg in this container (the path
# points nowhere), so no parser for foreign media runs with network. Joining,
# cutting and shrinking happen afterwards in `video_compact`, without network.
#
# If a post has no video, its images are loaded (at most MAX_IMAGES), raw: they
# are normalised afterwards in `image_to_jpeg`, also without network.
#
# Input (stdin): {"url": "..."}. Output (stdout): one JSON line, on success
# followed by the bytes of the parts in the stated order.
import json
import os
import re
import socket
import sys
import threading
import unicodedata

sys.path.insert(0, "/opt/serain-media/yt-dlp")
import yt_dlp  # noqa: E402
from yt_dlp.extractor.twitter import TwitterIE  # noqa: E402
from yt_dlp.networking import Request  # noqa: E402


def _no_syndication(self, twid):
    # On a rate limit yt-dlp falls back to another endpoint for X and poses as
    # Googlebot for it. That is disguise, and there is none of that here
    # (D35, D61): then X is simply closed for now.
    raise yt_dlp.utils.ExtractorError("X is limiting requests right now (rate limit)", expected=True)


TwitterIE._call_syndication_api = _no_syndication

PROXY_SOCKET = "/proxy/proxy.sock"
DOWNLOAD_DIR = "/tmp/dl"
# Only these extractors, never the generic one: it loads any page at all.
ALLOWED_EXTRACTORS = [r"tiktok$", r"vm\.tiktok$", r"instagram$", r"twitter$", r"twitter:card$", r"twitter:shortener$"]
MAX_SECONDS = 30 * 60
PART_MAX_BYTES = 48 * 1024 * 1024
# A post without a video (Instagram image post, TikTok photo series): at most this many images.
MAX_IMAGES = 10
IMAGE_MAX_BYTES = 8 * 1024 * 1024
TEXT_MAX = 1500


def forward(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (source, target):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def serve(listener):
    while True:
        client, _ = listener.accept()
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect(PROXY_SOCKET)
        except OSError:
            client.close()
            upstream.close()
            continue
        threading.Thread(target=forward, args=(client, upstream), daemon=True).start()
        threading.Thread(target=forward, args=(upstream, client), daemon=True).start()


def start_bridge():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    threading.Thread(target=serve, args=(listener,), daemon=True).start()
    return listener.getsockname()[1]


def clip(value):
    text = value if isinstance(value, str) else ""
    # Control, private and unassigned characters out: TikTok delivers music names made of U+FFF4 only.
    text = "".join(ch for ch in text if not unicodedata.category(ch).startswith("C") or ch.isspace())
    text = " ".join(text.split())
    return text[:TEXT_MAX] + ("…" if len(text) > TEXT_MAX else "")


def reason_of(message):
    lower = message.lower()
    if "unsupported url" in lower:
        return "unsupported"
    if "no video" in lower or "there is no video" in lower or "no formats" in lower or "requested format is not available" in lower:
        return "no_video"
    if any(word in lower for word in ("login", "log in", "cookies", "sign in", "rate-limit", "rate limit", "authentication")):
        return "login"
    if any(word in lower for word in ("private", "unavailable", "removed", "deleted", "not found", "404", "does not exist")):
        return "unavailable"
    return "failed"


def fail(reason, message=""):
    sys.stdout.write(json.dumps({"ok": False, "reason": reason, "message": clip(message)[:300]}) + "\n")
    sys.stdout.flush()
    sys.exit(0)


class Quiet:
    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        pass


def has_video(entry):
    """Did yt-dlp choose a format with a picture for this part?"""
    if not entry:
        return False
    chosen = entry.get("requested_formats") or ([entry] if entry.get("url") else [])
    return any(fmt.get("vcodec") != "none" for fmt in chosen)


def first_video(info):
    """A post with several parts (Instagram carousel) is a list: the first video counts."""
    if info.get("_type") == "playlist":
        return next((entry for entry in info.get("entries") or [] if has_video(entry)), None)
    return info if has_video(info) else None


def kind_of(fmt):
    # "none" means: certainly not included. Without the field it may be included
    # (Instagram names no sound codec for finished files); then "av", and
    # `video_compact` takes the sound if there is any.
    video = fmt.get("vcodec") != "none"
    audio = fmt.get("acodec") != "none"
    if video and audio:
        return "av"
    if video:
        return "v"
    return "a"


def best_thumbnail(entry):
    """yt-dlp sorts thumbnails from the smallest to the largest."""
    thumbnails = [t for t in entry.get("thumbnails") or [] if isinstance(t.get("url"), str)]
    return thumbnails[-1]["url"] if thumbnails else None


def instagram_images(info):
    """An image post or a carousel of images only: the images are the thumbnails of the parts."""
    entries = info.get("entries") if info.get("_type") == "playlist" else [info]
    return [url for url in (best_thumbnail(entry) for entry in entries or [] if entry) if url]


def tiktok_images(ydl, url):
    """
    A photo series: yt-dlp only delivers the music for it. The images are in
    the same page data its TikTok extractor reads anyway. That is an internal
    method of yt-dlp; if a new version no longer has it, the result stays
    "no images" (deploy/README.md).
    """
    match = re.search(r"/@([\w.-]+)/(?:video|photo)/(\d+)", url)
    if not match:
        return [], {}
    extractor = ydl.get_info_extractor("TikTok")
    try:
        data, status = extractor._extract_web_data_and_status(
            f"https://www.tiktok.com/@{match.group(1)}/video/{match.group(2)}", match.group(2), fatal=False
        )
    except (AttributeError, TypeError, yt_dlp.utils.ExtractorError):
        return [], {}
    if status != 0 or not isinstance(data, dict):
        return [], {}
    images = []
    for image in (data.get("imagePost") or {}).get("images") or []:
        candidates = ((image or {}).get("imageURL") or {}).get("urlList") or []
        if candidates and isinstance(candidates[0], str):
            images.append(candidates[0])
    music = data.get("music") or {}
    return images, {"desc": data.get("desc"), "music": music.get("title"), "music_by": music.get("authorName")}


def x_images(ydl, url):
    """
    A post on X with photos: yt-dlp reads all of it but only reports "no
    video". The photos are in the same status its X extractor fetches; as with
    TikTok through its internal method, and without it the text remains.
    """
    match = re.search(r"/status/(\d+)", url)
    if not match:
        return [], {}
    extractor = ydl.get_info_extractor("Twitter")
    try:
        status = extractor._extract_status(match.group(1))
    except (AttributeError, TypeError, yt_dlp.utils.ExtractorError):
        return [], {}
    if not isinstance(status, dict):
        return [], {}
    media = (status.get("extended_entities") or {}).get("media") or []
    urls = [
        f"{item['media_url_https']}?name=large"
        for item in media
        if isinstance(item, dict) and item.get("type") == "photo" and isinstance(item.get("media_url_https"), str)
    ]
    user = status.get("user") or {}
    text = status.get("full_text") or status.get("text") or ""
    # With photos, the last t.co link is the link to the photo itself.
    text = re.sub(r"\s*https?://t\.co/\w+$", "", text) if isinstance(text, str) else ""
    return urls, {"text": text, "user": user.get("name") or user.get("screen_name")}


def fetch_image(ydl, url, referer, path):
    response = ydl.urlopen(Request(url, headers={"Referer": referer}))
    size = 0
    with open(path, "wb") as handle:
        while True:
            chunk = response.read(256 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > IMAGE_MAX_BYTES:
                return 0
            handle.write(chunk)
    return size


def write(header, parts):
    out = sys.stdout.buffer
    out.write((json.dumps(header) + "\n").encode("utf-8"))
    for part in parts:
        with open(part["path"], "rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
    out.flush()


def download_video(ydl, info):
    duration = info.get("duration")
    if isinstance(duration, (int, float)) and duration > MAX_SECONDS:
        fail("too_long", str(int(duration)))
    parts = []
    for index, fmt in enumerate(info.get("requested_formats") or [info]):
        single = dict(info)
        single.pop("requested_formats", None)
        single.update(fmt)
        announced = fmt.get("filesize") or fmt.get("filesize_approx") or 0
        if announced > PART_MAX_BYTES:
            fail("too_big")
        path = os.path.join(DOWNLOAD_DIR, f"part{index}")
        ok, _ = ydl.dl(path, single)
        if not ok or not os.path.exists(path):
            # yt-dlp stops at max_filesize without an error when the size only shows while loading.
            fail("too_big" if not announced else "failed", "download incomplete")
        size = os.path.getsize(path)
        if size == 0:
            fail("failed", "empty file")
        if size > PART_MAX_BYTES:
            fail("too_big")
        parts.append({"path": path, "bytes": size, "kind": kind_of(fmt)})
    return parts, duration if isinstance(duration, (int, float)) else None


def download_images(ydl, urls, referer):
    parts = []
    for index, image_url in enumerate(urls[:MAX_IMAGES]):
        path = os.path.join(DOWNLOAD_DIR, f"image{index}")
        try:
            size = fetch_image(ydl, image_url, referer, path)
        except Exception:  # noqa: BLE001 - an image that does not load is simply missing
            size = 0
        if size > 0:
            parts.append({"path": path, "bytes": size, "kind": "image"})
    return parts


def main():
    try:
        request = json.loads(sys.stdin.read(4096))
        url = request["url"]
        if not isinstance(url, str) or not url.startswith("https://") or len(url) > 2000:
            raise ValueError
    except (ValueError, KeyError, TypeError):
        fail("failed", "input is not a URL")

    tiktok = "tiktok.com/" in url
    on_x = "x.com/" in url
    # yt-dlp knows photo series only under /video/; TikTok serves them there just the same.
    extract_url = re.sub(r"(tiktok\.com/@[\w.-]+)/photo/", r"\1/video/", url)
    port = start_bridge()
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    options = {
        "proxy": f"http://127.0.0.1:{port}",
        "allowed_extractors": ALLOWED_EXTRACTORS,
        # One file with picture and sound, otherwise picture and sound apart; at most
        # 480p, the model sees no more anyway. Direct files before segment lists.
        "format": "b/bv*+ba",
        "format_sort": ["res:480", "proto"],
        # A post without a video is no error: then its images count.
        "ignore_no_formats_error": True,
        "noplaylist": True,
        "playlist_items": f"1:{MAX_IMAGES}",
        "cachedir": False,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "logger": Quiet(),
        "socket_timeout": 20,
        "retries": 2,
        "fragment_retries": 2,
        "max_filesize": PART_MAX_BYTES,
        "ffmpeg_location": "/nonexistent",
        "fixup": "never",
        "postprocessors": [],
    }
    header = {"ok": True}
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            try:
                root = ydl.extract_info(extract_url, download=False)
            except yt_dlp.utils.DownloadError as error:
                # Older paths in the X extractor report a photo post as an error instead of a post without formats.
                if not on_x or reason_of(str(error)) != "no_video":
                    raise
                root = {}
            post = first_video(root)
            text = post or root
            header.update(
                {
                    "title": clip(text.get("title")),
                    "uploader": clip(text.get("uploader") or text.get("channel") or text.get("uploader_id") or root.get("uploader")),
                    "description": clip(text.get("description") or root.get("description")),
                }
            )
            if post is not None:
                parts, duration = download_video(ydl, post)
                header["duration"] = duration
            else:
                if tiktok:
                    urls, extra = tiktok_images(ydl, url)
                    referer = "https://www.tiktok.com/"
                    if extra.get("music"):
                        header["music"] = " by ".join(part for part in (clip(extra.get("music")), clip(extra.get("music_by"))) if part)
                    if not header["description"] and extra.get("desc"):
                        header["description"] = clip(extra["desc"])
                elif on_x:
                    urls, extra = x_images(ydl, url)
                    referer = "https://x.com/"
                    header["title"] = ""
                    header["uploader"] = header["uploader"] or clip(extra.get("user"))
                    header["description"] = clip(extra.get("text")) or header["description"]
                else:
                    urls = instagram_images(root)
                    referer = "https://www.instagram.com/"
                if not urls:
                    fail("no_video")
                parts = download_images(ydl, urls, referer)
                if not parts:
                    fail("failed", "images could not be loaded")
                header["images_total"] = len(urls)
    except yt_dlp.utils.DownloadError as error:
        message = str(error)
        fail(reason_of(message), message)

    if not any(part["kind"] in ("av", "v", "image") for part in parts):
        fail("no_video")
    header["parts"] = [{"bytes": part["bytes"], "kind": part["kind"]} for part in parts]
    write(header, parts)


main()
