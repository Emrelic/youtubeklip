// yt-dlp binary indir (build asamasinda calistirilir)
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const BIN_DIR = path.join(__dirname, "bin");
const isWin = process.platform === "win32";
const filename = isWin ? "yt-dlp.exe" : "yt-dlp";
const dest = path.join(BIN_DIR, filename);

if (fs.existsSync(dest)) {
  console.log("yt-dlp zaten mevcut: " + dest);
  process.exit(0);
}

const url = isWin
  ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
  : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

console.log("yt-dlp indiriliyor: " + url);

function download(url, dest, cb) {
  const mod = url.startsWith("https") ? https : http;
  mod.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return download(res.headers.location, dest, cb);
    }
    if (res.statusCode !== 200) {
      return cb(new Error("HTTP " + res.statusCode));
    }
    const ws = fs.createWriteStream(dest);
    res.pipe(ws);
    ws.on("finish", () => {
      ws.close();
      if (!isWin) fs.chmodSync(dest, 0o755);
      cb(null);
    });
  }).on("error", cb);
}

download(url, dest, (err) => {
  if (err) {
    console.error("yt-dlp indirilemedi:", err.message);
    process.exit(1);
  }
  console.log("yt-dlp indirildi: " + dest);
});
