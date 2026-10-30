// Servidor de medida y montaje con ffmpeg para el estudio de anuncios.
// Endpoints (todos con cabecera Authorization: Bearer <TOKEN>):
//   POST /medir   {clipUrl, palabrasGuion, falKey, off}        -> medidas de voz + audio limpio (base64 wav)
//   POST /montar  {...}                                          -> {job}
//   GET  /job/:id                                                -> {estado, resultado?, error?}
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const TOKEN = process.env.TOKEN;
const PORT = Number(process.env.PORT || 8080);
const jobs = new Map();

function run(cmd, args, timeoutMs = 300000) {
  return new Promise((ok, ko) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); ko(new Error(`${cmd} superó el tiempo máximo`)); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => { clearTimeout(t); c === 0 ? ok({ out, err }) : ko(new Error(err.slice(-1500))); });
  });
}
const X264 = ["-x264-params", "threads=1:lookahead-threads=1:rc-lookahead=0:ref=1:bframes=0:mbtree=0:sliced-threads=0"];
const ff = (args, t) => run("ffmpeg", ["-hide_banner", "-y", "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1", ...args, "-threads", "1"], t);
async function bajar(url, path) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`No se pudo descargar ${url.slice(0, 80)}`);
  await writeFile(path, Buffer.from(await r.arrayBuffer()));
}
async function volumen(file, filtro = "") {
  const { err } = await ff(["-i", file, "-af", `${filtro ? filtro + "," : ""}volumedetect`, "-f", "null", "-"], 60000);
  return { mean: +(/mean_volume: (-?[\d.]+)/.exec(err)?.[1] ?? -91), max: +(/max_volume: (-?[\d.]+)/.exec(err)?.[1] ?? -91) };
}
async function whisper(falKey, wavPath) {
  const b64 = (await readFile(wavPath)).toString("base64");
  const r = await fetch("https://fal.run/fal-ai/whisper", {
    method: "POST",
    signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: `data:audio/wav;base64,${b64}`, task: "transcribe", language: "es", chunk_level: "word" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = JSON.stringify(j);
    if (/exhausted balance|user is locked|top_up/i.test(m)) throw Object.assign(new Error("SALDO"), { saldo: true });
    throw new Error(`Whisper: ${m.slice(0, 300)}`);
  }
  const palabras = (j.chunks ?? []).map((c) => ({ w: String(c.text).trim(), s: c.timestamp?.[0] ?? 0, e: c.timestamp?.[1] ?? 0 })).filter((x) => x.w);
  return { texto: String(j.text ?? "").trim(), palabras };
}
async function pcm(file) {
  const { out } = await new Promise((ok, ko) => {
    const p = spawn("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"]);
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("close", (c) => (c === 0 ? ok({ out: Buffer.concat(chunks) }) : ko(new Error("pcm"))));
  });
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
}
function f0Mediana(x, sr = 16000) {
  const win = 640, res = [];
  for (let i = 0; i + win < x.length; i += 320) {
    let e = 0; for (let k = 0; k < win; k++) e += x[i + k] ** 2;
    if (e / win < 1e-4) continue;
    let best = 0, lag = 0;
    for (let l = Math.floor(sr / 400); l <= Math.floor(sr / 70); l++) {
      let c = 0; for (let k = 0; k < win - l; k++) c += x[i + k] * x[i + k + l];
      if (c > best) { best = c; lag = l; }
    }
    if (lag && best / e > 0.4) res.push(sr / lag);
  }
  res.sort((a, b) => a - b);
  return res.length ? Math.round(res[Math.floor(res.length / 2)]) : null;
}

async function medir({ clipUrl, palabrasGuion, falKey, off }) {
  const dir = await mkdtemp(join(tmpdir(), "m-"));
  try {
    const clip = join(dir, "c.mp4"), raw = join(dir, "raw.wav"), limpio = join(dir, "l.wav"), cort = join(dir, "t.wav");
    await bajar(clipUrl, clip);
    await ff(["-i", clip, "-vn", "-ac", "1", "-ar", "48000", raw]);
    const pico = (await volumen(raw)).max;
    // Limpieza: puerta a pico-38 dB con 120 ms de margen + paso alto 100 Hz
    const umbral = Math.pow(10, (pico - 38) / 20);
    await ff(["-i", raw, "-af", `highpass=f=100,agate=threshold=${umbral.toFixed(6)}:attack=5:release=120:range=0.001`, limpio]);
    const w1 = await whisper(falKey, limpio);
    const N = Math.max(1, palabrasGuion);
    const ws = w1.palabras;
    if (!ws.length) return { oida: w1.texto, palabras: [], error: "No se oye ninguna palabra" };
    const ini = ws[0].s, fin = ws[Math.min(N, ws.length) - 1].e;
    const a = Math.max(0, ini - (off ? 0.1 : 0.12)), b = fin + (off ? 0.3 : 0.25);
    // Silencio digital fuera del tramo, fundidos de 30 ms
    const vol = `volume='if(between(t,${a.toFixed(3)},${b.toFixed(3)}),1,0)':eval=frame`;
    await ff(["-i", limpio, "-af", `${vol},afade=t=in:st=${a.toFixed(3)}:d=0.03,afade=t=out:st=${(b - 0.03).toFixed(3)}:d=0.03${off ? `,atrim=${a}:${b},asetpts=PTS-STARTPTS` : ""}`, cort]);
    const w2 = await whisper(falKey, cort);
    const full = await volumen(cort), bajo = await volumen(cort, "lowpass=f=150");
    const ruido = Math.min(1, Math.pow(10, (bajo.mean - full.mean) / 10));
    const f0 = f0Mediana(await pcm(cort));
    return {
      oida: w1.texto, oidaRecortada: w2.texto, palabras: ws, inicio: ini, fin,
      ruido: Math.round(ruido * 1000) / 1000, segundosHabla: Math.round((fin - ini) * 100) / 100, f0,
      audioB64: (await readFile(cort)).toString("base64"),
    };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const esc = (t) => String(t).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%");
const ass = (t) => String(t).replace(/[{}]/g, "");
function tAss(s) { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(2).padStart(5, "0"); return `${h}:${String(m).padStart(2, "0")}:${x}`; }
function tSrt(s) { const ms = Math.round(s * 1000); const p = (n, l = 2) => String(n).padStart(l, "0"); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; }

async function montar(p) {
  const dir = await mkdtemp(join(tmpdir(), "j-"));
  try {
    const V = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,setsar=1";
    const piezas = [], subs = [];
    let t = 0;
    for (const [i, e] of p.escenas.entries()) {
      const out = join(dir, `p${i}.mp4`);
      if (e.clipUrl) {
        const src = join(dir, `s${i}.mp4`); await bajar(e.clipUrl, src);
        let ss = 0, dur = e.duracion;
        if (e.tipo === "habla" && e.inicio != null) { ss = Math.max(0, e.inicio - 0.35); dur = e.fin + 0.6 - ss; }
        const args = ["-ss", String(ss), "-t", String(dur), "-i", src];
        let audio = "-map 0:a?";
        if (e.audioUrl) { const au = join(dir, `a${i}.wav`); await bajar(e.audioUrl, au); args.push("-i", au); }
        const af = e.tipo === "habla" && e.audioUrl ? ["-map", "0:v", "-map", "1:a", "-af", `atrim=${ss}:${ss + dur},asetpts=PTS-STARTPTS`]
          : e.tipo === "off" && e.audioUrl ? ["-map", "0:v", "-map", "1:a", "-af", `adelay=${Math.round((e.retardoOff ?? 0.5) * 1000)}:all=1,apad`]
          : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", `${e.audioUrl ? 2 : 1}:a`];
        await ff([...args, ...af, "-t", String(dur), "-vf", V, "-c:v", "libx264", "-crf", "19", "-preset", "veryfast", ...X264, "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k", out]);
        void audio;
        if (e.frase && (e.tipo === "habla" || e.tipo === "off")) {
          const off = e.tipo === "habla" ? (e.inicio - ss) : (e.retardoOff ?? 0.5);
          const hab = e.tipo === "habla" ? e.fin - e.inicio : (e.segundosHabla ?? dur - off);
          subs.push({ a: t + off, b: t + off + hab + 0.2, txt: e.subtitulo || e.frase });
        }
        t += dur;
      } else {
        // Cartela / pantalla dibujada (texto real, nunca generado por IA)
        const lineas = (e.lineas ?? [e.frase]).filter(Boolean);
        const draw = lineas.map((l, k) => `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${esc(l)}':fontcolor=white:fontsize=${k === 0 ? 72 : 48}:x=(w-tw)/2:y=${560 + k * 110}`).join(",");
        const dur = e.duracion || 3;
        const ins = e.imagenUrl ? (await bajar(e.imagenUrl, join(dir, `i${i}.png`)), ["-loop", "1", "-i", join(dir, `i${i}.png`)]) : ["-f", "lavfi", "-i", "color=c=0x111111:s=1080x1920:r=30"];
        await ff([...ins, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(dur), "-vf", `${V}${draw ? "," + draw : ""}`, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-crf", "19", "-preset", "veryfast", ...X264, "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k", "-shortest", out], 90000);
        t += dur;
      }
      piezas.push(out);
    }
    await writeFile(join(dir, "l.txt"), piezas.map((x) => `file '${x}'`).join("\n"));
    const voz = join(dir, "voz.mp4");
    await ff(["-f", "concat", "-safe", "0", "-i", join(dir, "l.txt"), "-c", "copy", voz]);
    const total = t;
    // Subtítulos ASS: 54 px, caja oscura, parte de abajo en y ≤ 1248 (MarginV = 1920-1248)
    const assTxt = `[Script Info]\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\nStyle: S,DejaVu Sans,54,&H00FFFFFF,&H99000000,&H99000000,1,3,14,0,2,90,90,672\n\n[Events]\nFormat: Layer, Start, End, Style, Text\n` +
      subs.map((s) => `Dialogue: 0,${tAss(s.a)},${tAss(s.b)},S,${ass(s.txt)}`).join("\n");
    await writeFile(join(dir, "s.ass"), assTxt);
    const srt = subs.map((s, k) => `${k + 1}\n${tSrt(s.a)} --> ${tSrt(s.b)}\n${s.txt}\n`).join("\n");
    const mus = join(dir, "m.mp3"); await bajar(p.musicaUrl, mus);
    const drama = `drawbox=x=1080-56-330:y=300:w=330:h=70:color=black@0.6:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='Dramatización':fontcolor=white:fontsize=36:x=1080-56-330+(330-tw)/2:y=300+(70-th)/2`;
    const fijo = p.textoFijo ? `,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${esc(p.textoFijo)}':fontcolor=white:fontsize=44:box=1:boxcolor=black@0.6:boxborderw=16:x=(w-tw)/2:y=420` : "";
    const pre = join(dir, "pre.mp4");
    // Ducking: la música baja ~14 dB cuando la voz supera 0,003
    const fc = `[0:v]subtitles=${join(dir, "s.ass")},${drama}${fijo}[v];[1:a]atrim=0:${total},afade=t=in:d=0.25,afade=t=out:st=${Math.max(0, total - 1.2)}:d=1.2,volume=0.35[m];[0:a]asplit[va][vs];[m][vs]sidechaincompress=threshold=0.003:ratio=20:attack=150:release=250:makeup=1:level_sc=1[md];[va][md]amix=inputs=2:duration=first:normalize=0[a]`;
    await ff(["-i", voz, "-stream_loop", "-1", "-i", mus, "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "19", "-preset", "veryfast", ...X264, "-r", "30", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k", pre], 900000);
    // Sonoridad a −15 LUFS en dos pasos (medida + ganancia exacta + limitador)
    const m1 = await ff(["-i", pre, "-af", "ebur128=peak=true", "-f", "null", "-"]);
    const I = +(/I:\s+(-?[\d.]+) LUFS/g.exec(m1.err.slice(m1.err.lastIndexOf("Summary")))?.[1] ?? -15);
    const fin = join(dir, "final.mp4");
    await ff(["-i", pre, "-c:v", "copy", "-af", `volume=${(-15 - I).toFixed(2)}dB,alimiter=limit=0.84:level=false`, "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k", fin]);
    const medidas = await medirFinal(fin, subs, total, dir);
    const bytes = await readFile(fin);
    const up = await fetch(p.subidaUrl, { method: "PUT", headers: { "Content-Type": "video/mp4", "x-upsert": "true" }, body: bytes });
    if (!up.ok) throw new Error(`No se pudo subir el vídeo final (${up.status})`);
    return { srt, medidas, frames: medidas.frames, duracion: total };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function medirFinal(file, subs, total, dir) {
  const e = (await ff(["-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"])).err;
  const sum = e.slice(e.lastIndexOf("Summary"));
  const lufs = +(/I:\s+(-?[\d.]+) LUFS/.exec(sum)?.[1] ?? 0);
  const pico = +(/Peak:\s+(-?[\d.]+) dBFS/.exec(sum)?.[1] ?? 0);
  const sd = (await ff(["-i", file, "-af", "silencedetect=n=-45dB:d=0.5", "-f", "null", "-"])).err;
  const huecos = (sd.match(/silence_start/g) ?? []).length;
  const pr = JSON.parse((await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file])).out);
  const v = pr.streams.find((s) => s.codec_type === "video"), a = pr.streams.find((s) => s.codec_type === "audio");
  const frames = [];
  await ff(["-i", file, "-vf", "fps=1,scale=540:-2", join(dir, "f%03d.jpg")]);
  for (let k = 1; k <= Math.ceil(total); k++) { try { frames.push((await readFile(join(dir, `f${String(k).padStart(3, "0")}.jpg`))).toString("base64")); } catch {} }
  return {
    lufs, pico, huecos, ancho: v?.width, alto: v?.height, fps: v?.r_frame_rate, vcodec: v?.codec_name, acodec: a?.codec_name, ar: a?.sample_rate,
    subtitulosAbajoMax: 1248, subtitulos: subs.length, frames,
  };
}

http.createServer(async (req, res) => {
  const send = (c, o) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/salud") return send(200, { ok: true });
  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "No autorizado" });
  let body = ""; for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : {};
  try {
    if (req.method === "POST" && req.url === "/medir") return send(200, await medir(j));
    if (req.method === "POST" && req.url === "/montar") {
      const id = randomUUID(); jobs.set(id, { estado: "generando" });
      montar(j).then((r) => jobs.set(id, { estado: "listo", resultado: r })).catch((e) => jobs.set(id, { estado: "fallido", error: e.message }));
      return send(200, { job: id });
    }
    const m = /^\/job\/(.+)$/.exec(req.url ?? "");
    if (m) return send(200, jobs.get(m[1]) ?? { estado: "desconocido" });
    send(404, { error: "No existe" });
  } catch (e) { send(e.saldo ? 402 : 500, { error: e.message, saldo: !!e.saldo }); }
}).listen(PORT, () => console.log("ffmpeg-worker en", PORT));
