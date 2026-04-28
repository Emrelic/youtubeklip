const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const CLIPS_DIR = path.join(__dirname, "clips");
const TEMP_DIR = path.join(__dirname, "temp");

if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR);
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// yt-dlp yolu: Windows'ta binary, Linux'ta (Render) pip ile yuklenmis
const YTDLP_PATH = process.platform === "win32"
  ? path.join(__dirname, "bin", "yt-dlp.exe")
  : "yt-dlp";

// CORS - tum isteklerden once
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
});

app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

// ==================== YARDIMCI FONKSIYONLAR ====================

// Node.js yolunu bul (yt-dlp JS runtime olarak kullanacak)
const nodePath = process.execPath;

// yt-dlp komutu calistir
function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const fullArgs = [
      "--js-runtimes", "node:" + nodePath,
      "--no-check-certificates",
      "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ...args,
    ];
    execFile(YTDLP_PATH, fullArgs, { maxBuffer: 10 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        // stderr'den sadece ERROR satirlarini al
        const errorLines = (stderr || err.message)
          .split("\n")
          .filter(l => l.includes("ERROR"))
          .join(" ");
        return reject(new Error(errorLines || stderr || err.message));
      }
      resolve(stdout);
    });
  });
}

// YouTube URL dogrulama
function isValidYoutubeUrl(url) {
  return /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts)|youtu\.be\/)/.test(url);
}

// Video bilgisi al (yt-dlp --dump-json)
async function getVideoInfo(url) {
  const output = await ytdlp(["--dump-json", "--no-download", url]);
  const info = JSON.parse(output);
  return {
    title: info.title,
    duration: info.duration,
    thumbnail: info.thumbnail,
  };
}

// Video indir (yt-dlp ile)
function downloadVideo(url) {
  return new Promise(async (resolve, reject) => {
    const id = crypto.randomBytes(8).toString("hex");
    const tempPath = path.join(TEMP_DIR, `${id}.mp4`);

    try {
      const infoOutput = await ytdlp(["--dump-json", "--no-download", url]);
      const info = JSON.parse(infoOutput);

      await ytdlp([
        "-f", "best[ext=mp4]/best",
        "--no-playlist",
        "-o", tempPath,
        url,
      ]);

      resolve({ tempPath, title: info.title });
    } catch (err) {
      reject(err);
    }
  });
}

// Tek segment kes
function cutSegment(inputPath, start, duration, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      "-i", inputPath,
      "-ss", String(start),
      "-t", String(duration),
      "-c:v", "libx264",
      "-c:a", "aac",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ]);

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg hata kodu: ${code}`));
    });
    proc.on("error", reject);
  });
}

// Birden fazla dosyayi birlestir
function concatFiles(filePaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listPath = outputPath + ".list.txt";
    const listContent = filePaths
      .map((f) => `file '${f.replace(/\\/g, "/")}'`)
      .join("\n");
    fs.writeFileSync(listPath, listContent);

    const proc = spawn(ffmpegPath, [
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ]);

    proc.on("close", (code) => {
      try { fs.unlinkSync(listPath); } catch (_) {}
      if (code === 0) resolve();
      else reject(new Error(`Birlestirme hatasi: ${code}`));
    });
    proc.on("error", reject);
  });
}

// Temp dosyalari temizle
function cleanup(...paths) {
  for (const p of paths) {
    try {
      if (Array.isArray(p)) p.forEach((f) => fs.unlinkSync(f));
      else fs.unlinkSync(p);
    } catch (_) {}
  }
}

// ==================== API ENDPOINT'LERI ====================

// 1) Video bilgisi getir
app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url || !isValidYoutubeUrl(url)) {
    return res.status(400).json({ error: "Gecersiz YouTube URL" });
  }
  try {
    const info = await getVideoInfo(url);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: "Video bilgisi alinamadi: " + err.message });
  }
});

// 2) Tek veya coklu klip kes (ve birlestir)
app.post("/api/clip", async (req, res) => {
  const { url, segments } = req.body;

  if (!url || !isValidYoutubeUrl(url)) {
    return res.status(400).json({ error: "Gecersiz YouTube URL" });
  }
  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: "En az bir segment gerekli" });
  }

  for (const seg of segments) {
    if (seg.start == null || seg.end == null || seg.start >= seg.end) {
      return res.status(400).json({ error: "Gecersiz zaman araligi" });
    }
    if (seg.end - seg.start > 600) {
      return res.status(400).json({ error: "Her segment maksimum 10 dakika olabilir" });
    }
  }

  const id = crypto.randomBytes(8).toString("hex");

  try {
    const { tempPath, title } = await downloadVideo(url);
    const safeTitle = title.replace(/[^a-zA-Z0-9_\-\s]/g, "").trim().substring(0, 50);

    if (segments.length === 1) {
      const seg = segments[0];
      const filename = `${safeTitle}_${seg.start}-${seg.end}.mp4`;
      const outputPath = path.join(CLIPS_DIR, filename);

      await cutSegment(tempPath, seg.start, seg.end - seg.start, outputPath);
      cleanup(tempPath);

      return res.json({
        success: true,
        filename,
        downloadUrl: `/api/download/${encodeURIComponent(filename)}`,
      });
    }

    // Coklu segment: kes + birlestir
    const segPaths = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segPath = path.join(TEMP_DIR, `${id}_seg${i}.mp4`);
      await cutSegment(tempPath, seg.start, seg.end - seg.start, segPath);
      segPaths.push(segPath);
    }

    const filename = `${safeTitle}_birlesik_${id}.mp4`;
    const outputPath = path.join(CLIPS_DIR, filename);

    await concatFiles(segPaths, outputPath);
    cleanup(tempPath, segPaths);

    res.json({
      success: true,
      filename,
      downloadUrl: `/api/download/${encodeURIComponent(filename)}`,
    });
  } catch (err) {
    res.status(500).json({ error: "Hata: " + err.message });
  }
});

// 3) Dosya indir
app.get("/api/download/:filename", (req, res) => {
  const filename = req.params.filename;
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ error: "Gecersiz dosya adi" });
  }
  const filePath = path.join(CLIPS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Dosya bulunamadi" });
  }
  res.download(filePath);
});

// Eski dosyalari her 10 dakikada temizle (1 saatten eski)
setInterval(() => {
  const now = Date.now();
  [CLIPS_DIR, TEMP_DIR].forEach((dir) => {
    try {
      fs.readdirSync(dir).forEach((file) => {
        const fp = path.join(dir, file);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 3600000) fs.unlinkSync(fp);
      });
    } catch (_) {}
  });
}, 600000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`YouTube Klip sunucusu calisiyor: http://localhost:${PORT}`);
});
