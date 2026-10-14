// The sandbox helper (D8.7, D20). Deliberately plain JavaScript without a
// dependency and without a build: on the server the file is owned by root under
// /usr/local/lib/serain-sandbox/ and node starts it directly. Under /opt/serain
// the service `serain` could rewrite the code that runs with Docker rights, and
// Docker rights equal root.
//
// The helper is the only bridge between Serain and Docker. Over a Unix socket
// (systemd socket activation, group `serain`) it takes exactly one job per
// connection and runs a fixed `docker run` for it. From the client come only
// the name of a job from JOBS, a time limit, the input and, for spoken replies,
// a language that picks one of the fixed voices in VOICES; no value from the
// client ever ends up on the command line.
//
// Protocol: one JSON line, then `inputBytes` raw bytes. Response: one JSON
// line, then `outputBytes` raw bytes (the container's stdout).
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { pathToFileURL } from "node:url";

export const IMAGE = "serain-sandbox:1";
/** Spoken replies (D59): Piper needs glibc, the sandbox image is Alpine. Built from `Dockerfile.tts`. */
export const TTS_IMAGE = "serain-tts:1";

/**
 * The Piper voices in `serain-tts`, one per language, each at a fixed path
 * (`Dockerfile.tts`, ARG PIPER_VOICES; `PIPER_VOICES` in src/media/speech.ts
 * names the same languages). A language without a voice here gets no spoken
 * reply: the job refuses it, and Serain writes instead.
 */
export const VOICES = Object.freeze({
  de: "/opt/voice/de.onnx",
  en: "/opt/voice/en.onnx",
  es: "/opt/voice/es.onnx",
  fr: "/opt/voice/fr.onnx",
  it: "/opt/voice/it.onnx",
  nl: "/opt/voice/nl.onnx",
  pl: "/opt/voice/pl.onnx",
  pt: "/opt/voice/pt.onnx",
  ru: "/opt/voice/ru.onnx",
  tr: "/opt/voice/tr.onnx",
});

const MB = 1024 * 1024;

/** The start program of `compute`, as a function so it can stand before JOBS. */
function computeBootstrap() {
  return [
    "import json, os, re, sys",
    "def _setup():",
    "    src = sys.stdin.buffer",
    "    head = json.loads(src.readline())",
    "    code = src.read(int(head['code'])).decode('utf-8')",
    "    os.mkdir('/tmp/files')",
    "    for f in head.get('files', []):",
    "        if not re.fullmatch(r'[0-9a-f]{16}', f['id']): raise SystemExit('invalid file id')",
    "        with open('/tmp/files/' + f['id'], 'wb') as out: out.write(src.read(int(f['size'])))",
    "    os.chdir('/tmp/files')",
    "    sys.stdin = open(os.devnull)",
    "    return code",
    "exec(compile(_setup(), '<compute>', 'exec'), {'__name__': '__main__'})",
  ].join("\n");
}

/**
 * Whisper's own report of the language it heard, reduced to one line on
 * stderr: `language=de p=0.981230`. Everything else whisper logs stays in the
 * container; on failure the end of its log goes to stderr instead.
 */
const WHISPER_REPORT =
  "sed -n 's/^.*auto-detected language: \\([a-z]\\{2,3\\}\\) (p = \\([0-9.]*\\)).*$/language=\\1 p=\\2/p' /tmp/w.log | head -n 1 >&2";

/**
 * The fixed jobs. `argv` is the command inside the container; for a job with
 * `voices` it is a function of the voice's fixed path. Media go over stdin into
 * a file in the tmpfs, because ffmpeg and ImageMagick have to seek in some
 * containers (m4a with moov at the end, HEIC) and cannot do that on a pipe.
 */
export const JOBS = {
  python: {
    argv: ["python3", "-I", "-"],
    maxInput: 64 * 1024,
    maxOutput: 64 * 1024,
    maxTimeoutMs: 30_000,
    memory: "256m",
  },
  node: {
    argv: ["node", "-"],
    maxInput: 64 * 1024,
    maxOutput: 64 * 1024,
    maxTimeoutMs: 30_000,
    memory: "256m",
  },
  // Computing in the chat (D58): Python with files the owner has sent. On
  // stdin come one JSON line ({ code, files: [{ id, size }] }), then the code,
  // then the files. The fixed start program stores each file under its ID in
  // the working directory and runs the code there; nothing from the client is
  // on the command line, only bytes on stdin.
  compute: {
    argv: ["python3", "-I", "-c", computeBootstrap()],
    maxInput: 25 * MB,
    maxOutput: 64 * 1024,
    maxTimeoutMs: 30_000,
    memory: "512m",
  },
  // Voice message to text (D21): ffmpeg normalises to 16 kHz mono, at most two
  // minutes, whisper.cpp transcribes. All in the same container, none of it
  // leaves the server. The language is detected (`-l auto`): the owner may
  // speak any language, and a fixed one makes whisper translate or garble
  // everything else. Detection costs one more encoder pass over the first 30 s
  // (almost twice the time for a short message, D21), the price of a correct
  // transcript. Greedy decoding (`-bs 1 -bo 1`) instead of beam search:
  // measured on 2026-10-05 on the Oracle ARM for 53 s of audio, 44 s instead of
  // 152 s (with v1.9.4 and q8_0, D21 addendum), same text; on a real voice
  // message of the same day beam search even lost a passage. Whisper's logs go
  // to a file; only the detected language comes back (WHISPER_REPORT).
  audio_to_text: {
    argv: [
      "sh",
      "-c",
      "cat > /tmp/in && ffmpeg -nostdin -hide_banner -loglevel error -i /tmp/in -vn -ac 1 -ar 16000 -t 120 -f wav /tmp/a.wav " +
        "&& { whisper-cli -m /opt/whisper/model.bin -l auto -t 2 -bs 1 -bo 1 -nt -f /tmp/a.wav 2>/tmp/w.log; s=$?; " +
        `${WHISPER_REPORT}; [ $s -eq 0 ] || tail -c 2000 /tmp/w.log >&2; exit $s; }`,
    ],
    maxInput: 12 * MB,
    maxOutput: 64 * 1024,
    maxTimeoutMs: 240_000,
    memory: "2g",
    cpus: "2",
  },
  // Text to voice message (D59): Piper speaks with the voice of the language,
  // ffmpeg turns it into AAC mono 24 kHz in an m4a container, the format iMessage
  // voice messages use. Muxing goes into a file: m4a needs an output ffmpeg can
  // seek in.
  text_to_voice: {
    image: TTS_IMAGE,
    voices: VOICES,
    argv: (model) => [
      "sh",
      "-c",
      `cat > /tmp/in && python3 -m piper -m ${model} -f /tmp/a.wav < /tmp/in > /dev/null ` +
        "&& ffmpeg -nostdin -hide_banner -loglevel error -i /tmp/a.wav -ac 1 -ar 24000 -c:a aac -b:a 32k " +
        "-movflags +faststart -f ipod /tmp/v.m4a && cat /tmp/v.m4a",
    ],
    maxInput: 4 * 1024,
    maxOutput: 2 * MB,
    maxTimeoutMs: 60_000,
    memory: "512m",
    cpus: "2",
  },
  // Finished speech to voice message (D59 addendum): MP3 from Fish Audio via
  // OpenRouter becomes AAC mono 24 kHz in an m4a container, as with Piper. The
  // audio comes from outside, so ffmpeg parses it here and not in the service.
  audio_to_voice: {
    argv: [
      "sh",
      "-c",
      "cat > /tmp/in && ffmpeg -nostdin -hide_banner -loglevel error -i /tmp/in -vn -ac 1 -ar 24000 -c:a aac -b:a 32k " +
        "-t 120 -movflags +faststart -f ipod /tmp/v.m4a && cat /tmp/v.m4a",
    ],
    maxInput: 4 * MB,
    maxOutput: 2 * MB,
    maxTimeoutMs: 30_000,
    memory: "256m",
  },
  image_to_jpeg: {
    argv: [
      "sh",
      "-c",
      "cat > /tmp/in && magick '/tmp/in[0]' -auto-orient -strip -resize '1568x1568>' -quality 85 jpeg:-",
    ],
    maxInput: 12 * MB,
    maxOutput: 12 * MB,
    maxTimeoutMs: 60_000,
    memory: "512m",
  },
  // PDF from the web to text (D20 addendum of 2026-10-09): menus, price lists,
  // official texts for `web_fetch`. The parser for foreign files runs here,
  // without network, never in the service. At most 40 pages; a PDF made only of
  // images yields no text.
  pdf_to_text: {
    argv: ["sh", "-c", "cat > /tmp/in && pdftotext -q -layout -enc UTF-8 -l 40 /tmp/in -"],
    maxInput: 20 * MB,
    maxOutput: 2 * MB,
    maxTimeoutMs: 30_000,
    memory: "256m",
  },
  // A short PDF as one image per page (decision of 2026-10-09): the owner sees a
  // menu right in the chat that way, without tapping. At most three pages,
  // otherwise exit 3 and the PDF goes as a file. Longest side 2000 px. Output
  // per page: its length in ten digits, then the JPEG. The parser for foreign
  // files runs here, without network.
  pdf_to_pages: {
    argv: [
      "sh",
      "-c",
      "cat > /tmp/in && n=$(pdfinfo /tmp/in 2>/dev/null | awk '/^Pages:/{print $2}') && [ -n \"$n\" ] && [ \"$n\" -le 3 ] || exit 3; " +
        "pdftoppm -q -jpeg -jpegopt quality=82 -scale-to 2000 -l 3 /tmp/in /tmp/p && " +
        "for f in /tmp/p-*.jpg; do printf '%010d' \"$(stat -c %s \"$f\")\" && cat \"$f\"; done",
    ],
    maxInput: 20 * MB,
    maxOutput: 12 * MB,
    maxTimeoutMs: 30_000,
    memory: "256m",
  },
  // Load a video from TikTok, Instagram or X (D61). This container has no
  // network either: its only way out is the socket of the filter proxy that
  // Serain creates in MEDIA_PROXY_DIR (public addresses only, ports 80 and 443
  // only). No ffmpeg on this path: loading happens here, decoding in
  // `video_compact`.
  media_fetch: {
    argv: ["python3", "-I", "/opt/serain-media/media_fetch.py"],
    maxInput: 4 * 1024,
    maxOutput: 100 * MB,
    maxTimeoutMs: 150_000,
    memory: "768m",
    tmpfs: "160m",
    pids: 128,
    proxy: true,
  },
  // Shrink the loaded video and cut it to 15 minutes (D61), without network.
  video_compact: {
    argv: ["python3", "-I", "/opt/serain-media/video_compact.py"],
    maxInput: 100 * MB,
    maxOutput: 32 * MB,
    maxTimeoutMs: 180_000,
    memory: "1g",
    cpus: "2",
    tmpfs: "160m",
  },
};

/**
 * Where Serain creates the socket of its filter proxy (`SERAIN_MEDIA_PROXY_DIR`
 * in serain.service). Fixed in the helper, never from the client: only this
 * directory is ever handed into a container, read-only, and only for
 * `media_fetch`. `--mount` instead of `-v`: if the directory is missing, the
 * start fails instead of Docker creating it empty.
 */
export const MEDIA_PROXY_DIR = "/run/serain/media-proxy";

const MAX_STDERR = 8 * 1024;
const MAX_HEADER = 4 * 1024;
export const MAX_CONCURRENT = 2;

/** A language as the client sent it, safe to repeat in an error: a short code or nothing. */
function shownLanguage(language) {
  return typeof language === "string" && /^[a-z]{2,3}$/.test(language) ? language : "this language";
}

/**
 * The command inside the container. A job with voices needs a language that
 * has one and gets that voice's fixed path; every other job takes no language.
 */
function commandOf(job, language) {
  if (!job.voices) {
    if (language !== undefined) throw new Error("this job takes no language");
    return job.argv;
  }
  if (language === undefined) throw new Error("language missing");
  if (typeof language !== "string" || !Object.hasOwn(job.voices, language)) {
    throw new Error(`no voice for ${shownLanguage(language)}`);
  }
  return job.argv(job.voices[language]);
}

/** The command line for a job. Nothing in it comes from the client. */
export function dockerArgs(jobName, containerName, language) {
  const job = Object.hasOwn(JOBS, jobName) ? JOBS[jobName] : undefined;
  if (!job) throw new Error(`unknown job: ${jobName}`);
  const argv = commandOf(job, language);
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(job.pids ?? 64),
    "--memory",
    job.memory,
    "--memory-swap",
    job.memory,
    "--cpus",
    job.cpus ?? "1",
    "--user",
    "65534:65534",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${job.tmpfs ?? "64m"}`,
    ...(job.proxy ? ["--mount", `type=bind,source=${MEDIA_PROXY_DIR},target=/proxy,readonly`] : []),
    "--workdir",
    "/tmp",
    "--env",
    "HOME=/tmp",
    "--log-driver",
    "none",
    job.image ?? IMAGE,
    ...argv,
  ];
}

/** Checks the head of a request. Throws with a reason that goes back to the client. */
export function parseHeader(line) {
  let header;
  try {
    header = JSON.parse(line);
  } catch {
    throw new Error("header is not JSON");
  }
  if (!header || typeof header !== "object") throw new Error("header is not an object");
  const job = typeof header.job === "string" && Object.hasOwn(JOBS, header.job) ? JOBS[header.job] : undefined;
  if (!job) throw new Error("unknown job");
  const inputBytes = header.inputBytes;
  if (!Number.isInteger(inputBytes) || inputBytes < 1 || inputBytes > job.maxInput) {
    throw new Error(`input too large or empty (max ${job.maxInput} bytes)`);
  }
  const language = header.language;
  commandOf(job, language);
  const wanted = Number.isInteger(header.timeoutMs) ? header.timeoutMs : job.maxTimeoutMs;
  const timeoutMs = Math.min(Math.max(wanted, 1_000), job.maxTimeoutMs);
  return { jobName: header.job, job, inputBytes, timeoutMs, ...(language === undefined ? {} : { language }) };
}

export function createSandboxServer({ spawn = nodeSpawn, dockerBin = "/usr/bin/docker", log = console.error } = {}) {
  let active = 0;

  function respond(socket, header, output = Buffer.alloc(0)) {
    if (socket.destroyed) return;
    socket.end(Buffer.concat([Buffer.from(`${JSON.stringify({ ...header, outputBytes: output.length })}\n`), output]));
  }

  function handle(socket) {
    // The head is assembled, the input only collected: a video comes in
    // thousands of pieces, and copying everything each time would be quadratic.
    let head = Buffer.alloc(0);
    const body = [];
    let bodyBytes = 0;
    let request = null;
    let started = false;

    const fail = (reason) => respond(socket, { ok: false, error: reason });

    socket.on("data", (chunk) => {
      if (started) return;
      if (!request) {
        head = Buffer.concat([head, chunk]);
        const newline = head.indexOf(0x0a);
        if (newline < 0) {
          if (head.length > MAX_HEADER) fail("header too long");
          return;
        }
        try {
          request = parseHeader(head.subarray(0, newline).toString("utf8"));
        } catch (error) {
          fail(error.message);
          return;
        }
        chunk = head.subarray(newline + 1);
        head = Buffer.alloc(0);
      }
      body.push(chunk);
      bodyBytes += chunk.length;
      if (bodyBytes < request.inputBytes) return;
      started = true;
      run(socket, request, Buffer.concat(body, bodyBytes).subarray(0, request.inputBytes));
    });
    socket.on("error", () => undefined);
  }

  function run(socket, request, input) {
    if (active >= MAX_CONCURRENT) {
      respond(socket, { ok: false, error: "sandbox is busy" });
      return;
    }
    active += 1;
    const name = `serain-sbx-${randomBytes(6).toString("hex")}`;
    const child = spawn(dockerBin, dockerArgs(request.jobName, name, request.language), { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let outBytes = 0;
    let truncated = false;
    let stderr = "";
    let timedOut = false;
    let done = false;

    const kill = () => {
      // Ending `docker run` leaves the container running; it is stopped by its name.
      spawn(dockerBin, ["kill", name], { stdio: "ignore" }).on("error", () => undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, request.timeoutMs);
    // A closed connection means nobody is waiting any more (kill switch, shutdown, abort).
    socket.on("close", () => {
      if (!done) kill();
    });

    child.stdout.on("data", (chunk) => {
      const room = request.job.maxOutput - outBytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      out.push(part);
      outBytes += part.length;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8").slice(0, MAX_STDERR - stderr.length);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      finish({ ok: false, error: `docker could not start: ${error.message}` });
    });
    child.on("close", (code) => {
      finish({ ok: true, exitCode: code ?? -1, timedOut, truncated, stderr });
    });
    child.stdin.end(input);

    function finish(header) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      active -= 1;
      log(`${request.jobName} ${name} exit=${header.exitCode ?? "-"} timeout=${timedOut} in=${input.length} out=${outBytes}`);
      respond(socket, header, header.ok ? Buffer.concat(out) : undefined);
    }
  }

  return net.createServer(handle);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // systemd hands the socket in as fd 3 (serain-sandbox.socket). Without it the
  // helper does not start: creating a socket of its own with its own rights
  // would be exactly the place where the group `serain` got lost.
  if (process.env.LISTEN_FDS !== "1") {
    console.error("No socket from systemd (LISTEN_FDS). Start only through serain-sandbox.socket.");
    process.exit(1);
  }
  createSandboxServer().listen({ fd: 3 }, () => console.error("Sandbox helper ready"));
}
