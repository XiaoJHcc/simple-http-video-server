import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import mime from "mime-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.dir || process.env.VIDEO_DIR || "D:/Video");
const HOST = args.host || process.env.HOST || "0.0.0.0";
const PORT = Number(args.port || process.env.PORT || 8080);
const THUMB_DIR = path.resolve(
  args.thumbDir || process.env.THUMB_DIR || path.join(os.tmpdir(), "simple-http-video-server-thumbs"),
);
const THUMB_WIDTH = 480;
const STREAM_HIGH_WATER_MARK = 2 * 1024 * 1024;
const THUMB_PREFIX = "/__thumb__/";

const VIDEO_EXT = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".avi",
  ".mov",
  ".m4v",
  ".ts",
  ".m2ts",
  ".wmv",
  ".flv",
  ".mpg",
  ".mpeg",
  ".3gp",
  ".ogv",
]);

const IMAGE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".avif",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
]);

const PLACEHOLDER_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
  <rect width="480" height="270" fill="#1a1f2b"/>
  <circle cx="240" cy="118" r="34" fill="#2a3344"/>
  <path d="M230 102v32l28-16z" fill="#8ab4f8"/>
  <text x="240" y="190" text-anchor="middle" fill="#6b7280" font-family="system-ui,sans-serif" font-size="16">No preview</text>
</svg>`,
);

const FOLDER_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
  <rect width="480" height="270" fill="#151a24"/>
  <path d="M150 96h70l18 18h92c12 0 22 10 22 22v70c0 12-10 22-22 22H150c-12 0-22-10-22-22V118c0-12 10-22 22-22z" fill="#3b82f6" opacity=".85"/>
  <path d="M150 122h180c8 0 14 6 14 14v52c0 8-6 14-14 14H150c-8 0-14-6-14-14v-52c0-8 6-14 14-14z" fill="#60a5fa"/>
</svg>`,
);

const FILE_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
  <rect width="480" height="270" fill="#151a24"/>
  <path d="M196 72h64l44 44v98c0 10-8 18-18 18H196c-10 0-18-8-18-18V90c0-10 8-18 18-18z" fill="#2a3344"/>
  <path d="M260 72v36c0 6 4 10 10 10h34" fill="none" stroke="#4b5563" stroke-width="4"/>
  <rect x="210" y="140" width="80" height="8" rx="4" fill="#4b5563"/>
  <rect x="210" y="158" width="56" height="8" rx="4" fill="#374151"/>
</svg>`,
);

/** @type {Map<string, Promise<string|null>>} */
const thumbJobs = new Map();
let ffmpegAvailable = null;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" || a === "-d") out.dir = argv[++i];
    else if (a === "--port" || a === "-p") out.port = argv[++i];
    else if (a === "--host" || a === "-h") out.host = argv[++i];
    else if (a === "--thumb-dir") out.thumbDir = argv[++i];
    else if (a === "--help") out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Usage: node server.js [options]

Options:
  -d, --dir <path>       Video root directory (default: D:/Video or VIDEO_DIR)
  -p, --port <n>         Port (default: 8080 or PORT)
  -h, --host <addr>      Bind address (default: 0.0.0.0 or HOST)
      --thumb-dir <path> Thumbnail cache dir (default: temp/simple-http-video-server-thumbs)
`);
}

function isInsideRoot(absPath) {
  const rel = path.relative(ROOT, absPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function decodeUrlPath(urlPath) {
  return decodeURIComponent(urlPath).replace(/\+/g, " ");
}

function toUrlPath(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join("/");
  return "/" + rel.split("/").map(encodeURIComponent).join("/");
}

function toThumbUrl(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join("/");
  return THUMB_PREFIX + rel.split("/").map(encodeURIComponent).join("/");
}

function contentType(filePath) {
  return mime.lookup(filePath) || "application/octet-stream";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function mediaKind(name, isDir) {
  if (isDir) return "folder";
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return "file";
}

/** First direct child cover: prefer first image, else first video (non-recursive). */
async function firstMediaInDir(absDir) {
  let names;
  try {
    names = await fs.readdir(absDir);
  } catch {
    return null;
  }
  names = names
    .filter((n) => !n.startsWith("."))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  let firstVideo = null;
  for (const name of names) {
    const kind = mediaKind(name, false);
    if (kind !== "image" && kind !== "video") continue;
    const full = path.join(absDir, name);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    if (kind === "image") return full;
    if (!firstVideo) firstVideo = full;
  }
  return firstVideo;
}

async function listDir(absDir) {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const items = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(absDir, ent.name);
    let size = null;
    let mtime = null;
    try {
      const st = await fs.stat(full);
      size = st.size;
      mtime = st.mtime;
    } catch {
      continue;
    }
    const kind = mediaKind(ent.name, ent.isDirectory());
    let thumb = null;
    if (kind === "video" || kind === "image") {
      thumb = toThumbUrl(full);
    } else if (kind === "folder") {
      const cover = await firstMediaInDir(full);
      if (cover) thumb = toThumbUrl(cover);
    }
    items.push({
      name: ent.name,
      isDir: ent.isDirectory(),
      kind,
      size,
      mtime,
      href: toUrlPath(full) + (ent.isDirectory() ? "/" : ""),
      thumb,
    });
  }
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return items;
}

function formatSize(n) {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function renderIndex(absDir, items) {
  const rel = path.relative(ROOT, absDir);
  const title = rel ? rel.split(path.sep).join("/") : "/";
  const parts = rel ? rel.split(path.sep) : [];
  let crumb = `<a href="/">root</a>`;
  let acc = "";
  for (const p of parts) {
    acc += (acc ? "/" : "") + p;
    const href =
      "/" +
      acc
        .split("/")
        .map(encodeURIComponent)
        .join("/") +
      "/";
    crumb += ` <span>/</span> <a href="${href}">${escapeHtml(p)}</a>`;
  }

  const cards = items
    .map((it) => {
      const name = escapeHtml(it.name);
      const badge =
        it.kind === "folder"
          ? "文件夹"
          : it.kind === "video"
            ? "视频"
            : it.kind === "image"
              ? "图片"
              : "文件";
      const fallbackSvg =
        it.kind === "folder"
          ? FOLDER_SVG
          : it.kind === "file"
            ? FILE_SVG
            : PLACEHOLDER_SVG;
      const fallback = `data:image/svg+xml,${encodeURIComponent(fallbackSvg.toString())}`;
      let media;
      if (it.thumb) {
        media = `<img class="thumb" src="${it.thumb}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${fallback}'" />`;
      } else {
        media = `<img class="thumb" src="${fallback}" alt="" />`;
      }
      const meta = it.isDir ? "" : formatSize(it.size);
      return `<a class="card kind-${it.kind}" href="${it.href}" title="${name}">
  <div class="cover">${media}<span class="badge">${badge}</span></div>
  <div class="meta">
    <div class="name">${name}</div>
    ${meta ? `<div class="sub">${meta}</div>` : ""}
  </div>
</a>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Video Server</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d12;
      --fg: #eef1f6;
      --muted: #8b93a7;
      --line: #232a3a;
      --card: #121722;
      --card-hover: #182033;
      --link: #9ec1ff;
      --shadow: 0 8px 24px rgba(0,0,0,.28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 system-ui, "Segoe UI", sans-serif;
      background:
        radial-gradient(1200px 500px at 10% -10%, rgba(59,130,246,.16), transparent 60%),
        radial-gradient(900px 400px at 100% 0%, rgba(168,85,247,.10), transparent 55%),
        var(--bg);
      color: var(--fg);
      min-height: 100vh;
    }
    main { max-width: 1280px; margin: 0 auto; padding: 28px 18px 56px; }
    header { margin-bottom: 22px; }
    h1 { font-size: 22px; font-weight: 650; margin: 0 0 8px; letter-spacing: -.02em; }
    .crumb { color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .crumb a { color: var(--link); text-decoration: none; }
    .crumb a:hover { text-decoration: underline; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
      gap: 14px;
    }
    .card {
      display: flex;
      flex-direction: column;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      text-decoration: none;
      color: inherit;
      box-shadow: var(--shadow);
      transition: transform .15s ease, background .15s ease, border-color .15s ease;
    }
    .card:hover {
      transform: translateY(-2px);
      background: var(--card-hover);
      border-color: #334155;
    }
    .cover {
      position: relative;
      aspect-ratio: 16 / 10;
      background: #0e131c;
      overflow: hidden;
    }
    .thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      background: #0e131c;
    }
    .badge {
      position: absolute;
      left: 8px;
      top: 8px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      color: #dbe7ff;
      background: rgba(15, 23, 42, .72);
      border: 1px solid rgba(148, 163, 184, .25);
      backdrop-filter: blur(6px);
    }
    .kind-folder .badge { color: #dbeafe; }
    .kind-video .badge { color: #fecdd3; }
    .kind-image .badge { color: #bbf7d0; }
    .meta { padding: 10px 11px 12px; }
    .name {
      font-size: 13px;
      font-weight: 560;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
      min-height: 2.7em;
    }
    .sub { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .empty {
      grid-column: 1 / -1;
      color: var(--muted);
      text-align: center;
      padding: 48px 16px;
      border: 1px dashed var(--line);
      border-radius: 14px;
    }
    footer { margin-top: 22px; color: var(--muted); font-size: 12px; }
    @media (max-width: 560px) {
      .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
      main { padding: 18px 12px 40px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Video Server</h1>
      <div class="crumb">${crumb}</div>
    </header>
    <div class="grid">
      ${items.length ? cards : `<div class="empty">空目录</div>`}
    </div>
    <footer>点击文件即直链 · 可粘贴到播放器 · 缩略图需本机 ffmpeg</footer>
  </main>
</body>
</html>`;
}

function sendError(res, code, msg) {
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(msg);
}

function sendBuffer(res, buf, type, cache = "public, max-age=86400") {
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": buf.length,
    "Cache-Control": cache,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(buf);
}

function weakEtag(st) {
  return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

function parseTokenList(header) {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function etagMatches(header, etag) {
  const tags = parseTokenList(header);
  if (tags.includes("*")) return true;
  const bare = etag.replace(/^W\//, "");
  return tags.some((t) => t === etag || t === bare || t.replace(/^W\//, "") === bare);
}

function isFreshByModified(req, lastModified) {
  const ims = req.headers["if-modified-since"];
  if (!ims) return false;
  const since = Date.parse(ims);
  if (Number.isNaN(since)) return false;
  return Math.floor(lastModified.getTime() / 1000) <= Math.floor(since / 1000);
}

function isNotModified(req, etag, lastModified) {
  const inm = req.headers["if-none-match"];
  if (inm) return etagMatches(inm, etag);
  return isFreshByModified(req, lastModified);
}

function rangeFresh(req, etag, lastModified) {
  const ir = req.headers["if-range"];
  if (!ir) return true;
  if (ir.startsWith("W/") || ir.startsWith('"')) {
    return etagMatches(ir, etag);
  }
  const t = Date.parse(ir);
  if (Number.isNaN(t)) return false;
  return Math.floor(lastModified.getTime() / 1000) <= Math.floor(t / 1000);
}

function pipeFile(req, res, absPath, opts = {}) {
  const stream = createReadStream(absPath, {
    start: opts.start,
    end: opts.end,
    highWaterMark: STREAM_HIGH_WATER_MARK,
  });
  const onClose = () => {
    stream.destroy();
  };
  req.on("close", onClose);
  res.on("close", onClose);
  stream.on("error", (err) => {
    console.error("stream error:", absPath, err.message);
    if (!res.headersSent) sendError(res, 500, "Internal Server Error");
    else res.destroy();
  });
  stream.pipe(res);
}

function sendFile(req, res, absPath) {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return sendError(res, 404, "Not Found");
  }
  if (!st.isFile()) return sendError(res, 404, "Not Found");

  const size = st.size;
  const type = contentType(absPath);
  const etag = weakEtag(st);
  const lastModified = st.mtime;
  const headersBase = {
    "Accept-Ranges": "bytes",
    "Content-Type": type,
    ETag: etag,
    "Last-Modified": lastModified.toUTCString(),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
    "Cache-Control": "public, max-age=3600",
  };

  const ifMatch = req.headers["if-match"];
  if (ifMatch && !etagMatches(ifMatch, etag)) {
    res.writeHead(412, headersBase);
    return res.end();
  }

  let rangeHeader = req.headers.range;
  if (rangeHeader && rangeHeader.includes(",")) {
    res.writeHead(416, {
      ...headersBase,
      "Content-Range": `bytes */${size}`,
    });
    return res.end();
  }

  if (rangeHeader && !rangeFresh(req, etag, lastModified)) {
    rangeHeader = undefined;
  }

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (!m) {
      res.writeHead(416, {
        ...headersBase,
        "Content-Range": `bytes */${size}`,
      });
      return res.end();
    }
    let start = m[1] === "" ? NaN : Number(m[1]);
    let end = m[2] === "" ? NaN : Number(m[2]);
    if (Number.isNaN(start)) {
      const suffix = end;
      if (Number.isNaN(suffix) || suffix <= 0) {
        res.writeHead(416, {
          ...headersBase,
          "Content-Range": `bytes */${size}`,
        });
        return res.end();
      }
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start >= size || start > end || start < 0) {
        res.writeHead(416, {
          ...headersBase,
          "Content-Range": `bytes */${size}`,
        });
        return res.end();
      }
    }
    const chunk = end - start + 1;
    res.writeHead(206, {
      ...headersBase,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": chunk,
    });
    if (req.method === "HEAD") return res.end();
    return pipeFile(req, res, absPath, { start, end });
  }

  if (isNotModified(req, etag, lastModified)) {
    res.writeHead(304, headersBase);
    return res.end();
  }

  res.writeHead(200, {
    ...headersBase,
    "Content-Length": size,
  });
  if (req.method === "HEAD") return res.end();
  return pipeFile(req, res, absPath);
}

async function detectFfmpeg() {
  if (ffmpegAvailable != null) return ffmpegAvailable;
  ffmpegAvailable = await new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-version"], { windowsHide: true });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
  return ffmpegAvailable;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg exit ${code}`));
    });
  });
}

/**
 * Probe real playback video (skip embedded cover / attached_pic)
 * and duration for 1/3 seek.
 */
function probeVideoMeta(absPath) {
  return new Promise((resolve) => {
    const p = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-show_entries",
        "stream=index,codec_type,codec_name,duration,width,height,disposition",
        "-of",
        "json",
        absPath,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
    });
    p.on("error", () => resolve({ duration: null, streamIndex: null }));
    p.on("close", (code) => {
      if (code !== 0) return resolve({ duration: null, streamIndex: null });
      try {
        const data = JSON.parse(out);
        const streams = Array.isArray(data.streams) ? data.streams : [];
        const videos = streams.filter(
          (s) =>
            s.codec_type === "video" &&
            !(s.disposition && Number(s.disposition.attached_pic) === 1),
        );
        // Prefer the largest non-cover video stream (main feature).
        videos.sort((a, b) => {
          const pa = (Number(a.width) || 0) * (Number(a.height) || 0);
          const pb = (Number(b.width) || 0) * (Number(b.height) || 0);
          return pb - pa;
        });
        const main = videos[0] || null;
        let duration = null;
        const formatDur = Number.parseFloat(data.format?.duration);
        if (Number.isFinite(formatDur) && formatDur > 0) duration = formatDur;
        if (main?.duration != null) {
          const sd = Number.parseFloat(main.duration);
          if (Number.isFinite(sd) && sd > 0) duration = duration && duration > sd ? duration : sd;
          // Prefer stream duration when format duration looks like cover (tiny)
          if (!duration || (formatDur > 0 && formatDur < 1 && sd > formatDur)) duration = sd;
        }
        resolve({
          duration,
          streamIndex: main && Number.isInteger(main.index) ? main.index : null,
        });
      } catch {
        resolve({ duration: null, streamIndex: null });
      }
    });
  });
}

function videoThumbSeekSec(duration) {
  if (duration == null || !Number.isFinite(duration) || duration <= 0) return 3;
  if (duration < 3) return Math.max(0, duration * 0.5);
  const at = duration / 3;
  // stay away from exact start/end
  return Math.min(Math.max(at, 1), Math.max(duration - 1, 1));
}

function thumbCachePath(absPath, st) {
  const key = crypto
    .createHash("sha1")
    .update(`${absPath}|${st.size}|${Math.floor(st.mtimeMs)}|${THUMB_WIDTH}|pos1/3|nocover`)
    .digest("hex");
  return path.join(THUMB_DIR, `${key}.jpg`);
}

async function extractVideoFrame(absPath, seekSec, streamIndex, tmp, scale) {
  const seekStr = seekSec.toFixed(3);
  // Map main video only — default stream is often embedded cover art (1 frame).
  const mapArgs =
    streamIndex != null
      ? ["-map", `0:${streamIndex}`]
      : ["-map", "0:V:0"]; // V = video excluding attached_pic

  // 1) Fast input seek + explicit stream (usual path)
  try {
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      seekStr,
      "-i",
      absPath,
      ...mapArgs,
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-vf",
      scale,
      "-q:v",
      "4",
      "-y",
      tmp,
    ]);
    return;
  } catch {
    /* continue */
  }

  // 2) Accurate output seek (slower, correct when keyframe gap is large)
  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    absPath,
    "-ss",
    seekStr,
    ...mapArgs,
    "-frames:v",
    "1",
    "-an",
    "-sn",
    "-vf",
    scale,
    "-q:v",
    "4",
    "-y",
    tmp,
  ]);
}

async function generateThumb(absPath, st) {
  const ext = path.extname(absPath).toLowerCase();
  const out = thumbCachePath(absPath, st);
  if (existsSync(out)) return out;

  if (!(await detectFfmpeg())) return null;

  await fs.mkdir(THUMB_DIR, { recursive: true });
  const tmp = `${out}.${process.pid}.${Date.now()}.tmp.jpg`;
  const scale = `scale=${THUMB_WIDTH}:-2:flags=fast_bilinear`;

  try {
    if (VIDEO_EXT.has(ext)) {
      const meta = await probeVideoMeta(absPath);
      const seek = videoThumbSeekSec(meta.duration);
      await extractVideoFrame(absPath, seek, meta.streamIndex, tmp, scale);
    } else if (IMAGE_EXT.has(ext)) {
      await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        absPath,
        "-frames:v",
        "1",
        "-vf",
        scale,
        "-q:v",
        "4",
        "-y",
        tmp,
      ]);
    } else {
      return null;
    }
    await fs.rename(tmp, out);
    return out;
  } catch (err) {
    console.error("thumb failed:", absPath, err.message);
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    return null;
  }
}

function ensureThumb(absPath, st) {
  const out = thumbCachePath(absPath, st);
  if (existsSync(out)) return Promise.resolve(out);
  const key = out;
  let job = thumbJobs.get(key);
  if (!job) {
    job = generateThumb(absPath, st).finally(() => {
      thumbJobs.delete(key);
    });
    thumbJobs.set(key, job);
  }
  return job;
}

async function handleThumb(req, res, urlPath) {
  const rel = decodeUrlPath(urlPath.slice(THUMB_PREFIX.length));
  const abs = path.resolve(ROOT, rel);
  if (!isInsideRoot(abs)) return sendError(res, 403, "Forbidden");

  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    return sendBuffer(res, PLACEHOLDER_SVG, "image/svg+xml", "public, max-age=300");
  }
  if (!st.isFile()) {
    return sendBuffer(res, PLACEHOLDER_SVG, "image/svg+xml", "public, max-age=300");
  }

  const ext = path.extname(abs).toLowerCase();
  if (!VIDEO_EXT.has(ext) && !IMAGE_EXT.has(ext)) {
    return sendBuffer(res, FILE_SVG, "image/svg+xml", "public, max-age=86400");
  }

  // Small images: serve original (faster, sharper)
  if (IMAGE_EXT.has(ext) && st.size <= 256 * 1024) {
    return sendFile(req, res, abs);
  }

  const thumb = await ensureThumb(abs, st);
  if (!thumb) {
    return sendBuffer(res, PLACEHOLDER_SVG, "image/svg+xml", "public, max-age=60");
  }
  return sendFile(req, res, thumb);
}

async function handle(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers":
          "Range, Content-Type, If-Range, If-None-Match, If-Modified-Since, If-Match",
        "Access-Control-Expose-Headers":
          "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
        "Access-Control-Max-Age": "86400",
      });
      return res.end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendError(res, 405, "Method Not Allowed");
    }

    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    let urlPath = decodeUrlPath(u.pathname);
    if (urlPath.includes("\0")) return sendError(res, 400, "Bad Request");

    if (urlPath === THUMB_PREFIX.slice(0, -1) || urlPath.startsWith(THUMB_PREFIX)) {
      if (urlPath === THUMB_PREFIX.slice(0, -1) || urlPath === THUMB_PREFIX) {
        return sendError(res, 404, "Not Found");
      }
      return handleThumb(req, res, urlPath);
    }

    const rel = urlPath.replace(/^\/+/, "");
    const abs = path.resolve(ROOT, rel);
    if (!isInsideRoot(abs)) return sendError(res, 403, "Forbidden");

    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      return sendError(res, 404, "Not Found");
    }

    if (st.isDirectory()) {
      if (!u.pathname.endsWith("/")) {
        res.writeHead(302, { Location: u.pathname + "/" + u.search });
        return res.end();
      }
      const items = await listDir(abs);
      const html = renderIndex(abs, items);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      if (req.method === "HEAD") return res.end();
      return res.end(html);
    }

    if (st.isFile()) {
      return sendFile(req, res, abs);
    }
    return sendError(res, 404, "Not Found");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendError(res, 500, "Internal Server Error");
    else res.end();
  }
}

async function main() {
  if (args.help) {
    usage();
    process.exit(0);
  }

  let rootStat;
  try {
    rootStat = await fs.stat(ROOT);
  } catch {
    console.error(`Video directory not found: ${ROOT}`);
    process.exit(1);
  }
  if (!rootStat.isDirectory()) {
    console.error(`Not a directory: ${ROOT}`);
    process.exit(1);
  }

  await fs.mkdir(THUMB_DIR, { recursive: true });
  const hasFf = await detectFfmpeg();

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.keepAliveTimeout = 72_000;
  server.headersTimeout = 75_000;
  server.requestTimeout = 0;
  server.maxRequestsPerSocket = 0;

  server.listen(PORT, HOST, () => {
    console.log(`Video root: ${ROOT}`);
    console.log(`Thumb cache: ${THUMB_DIR}`);
    console.log(`ffmpeg: ${hasFf ? "available" : "NOT FOUND (placeholders only)"}`);
    console.log(`Listening:  http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}/`);
  });
}

main();
