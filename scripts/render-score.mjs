// Renders the score offline and measures it, so the mix can be judged by numbers (src/economy/score).
//
//   npm run dev -- --port 5305
//   node scripts/render-score.mjs [http://127.0.0.1:5305] [--out DIR] [--seconds 20]
//
// The dev server is only used to hand the browser the score's modules. Each state is rendered for 20 s through the
// real engine on an OfflineAudioContext (no game, no sound card), then measured: RMS and peak in dBFS at the
// score's own output, the same after the game's music bus (x0.62) against a rifle shot's peak (0.92 on the near
// bus), and the spectral centroid. `stalker` is infiltrate with a standing Bailiff at 10 m; `ending-whole` is the
// whole theme and the start of its tail (110 s). A WAV of each goes to DIR (default: a folder in the OS temp dir).
// Exits non-zero if a state is silent, clips, or sits less than 9 dB under the rifle.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch } from "./browser.mjs";

const arg = (name, fallback) => (process.argv.indexOf(name) > 0 ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const base = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5305";
const out = arg("--out", join(tmpdir(), "saltline-score"));
const seconds = Number(arg("--seconds", 20));
mkdirSync(out, { recursive: true });

const RENDERS = [
  ...["title", "infiltrate", "combat", "setpiece", "boss", "clear", "debrief", "dead", "ending"].map((s) => ({ name: s, base: s, seconds })),
  { name: "stalker", base: "infiltrate", stalker: 1, dist: 10, seconds },
  { name: "stalker-close", base: "combat", stalker: 1, dist: 4, seconds },
  { name: "ending-whole", base: "ending", seconds: 110 },
];
const RIFLE = 0.92;
const BUS = 0.62;

const browser = await launch();
let failed = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => (console.log("page error:", String(e)), failed++));
  await page.goto(`${base}/package.json`, { waitUntil: "load" }); // any same-origin page: only the modules are wanted
  console.log(`state            rms dBFS  peak dBFS  peak    bus peak vs rifle  centroid Hz  first 3 s rms`);
  for (const r of RENDERS) {
    const res = await page.evaluate(async (r) => {
      const { createEngine } = await import("/src/economy/score/engine.ts");
      const { heartRate } = await import("/src/economy/score/state.ts");
      const sr = 48000;
      const ctx = new OfflineAudioContext(2, sr * r.seconds, sr);
      const engine = createEngine(ctx, ctx.destination);
      engine.set({ state: r.stalker ? "stalker" : r.base, base: r.base, stalker: r.stalker || 0, heartBpm: r.stalker ? heartRate(r.dist) : 0, intensity: 1 });
      engine.level(1);
      const nodes = engine.nodes(); // the fixed set; struck metal comes and goes on top (the smoke test counts it live)
      engine.advance(r.seconds);
      const buf = await ctx.startRendering();
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      let peak = 0;
      let sq = 0;
      let sq3 = 0;
      let step = 0;
      for (let i = 0; i < L.length; i++) {
        const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        if (a > peak) peak = a;
        sq += (L[i] * L[i] + R[i] * R[i]) / 2;
        if (i < sr * 3) sq3 += (L[i] * L[i] + R[i] * R[i]) / 2;
        if (i) step = Math.max(step, Math.abs(L[i] - L[i - 1]));
      }
      // Spectral centroid: the magnitude-weighted mean frequency over Hann-windowed frames of the mono mix.
      const N = 4096;
      const re = new Float32Array(N);
      const im = new Float32Array(N);
      const mag = new Float64Array(N / 2);
      const fft = () => {
        for (let i = 1, j = 0; i < N; i++) {
          let bit = N >> 1;
          for (; j & bit; bit >>= 1) j ^= bit;
          j ^= bit;
          if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
          }
        }
        for (let len = 2; len <= N; len <<= 1) {
          const ang = (-2 * Math.PI) / len;
          for (let i = 0; i < N; i += len) {
            for (let k = 0; k < len / 2; k++) {
              const wr = Math.cos(ang * k);
              const wi = Math.sin(ang * k);
              const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
              const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
              re[i + k + len / 2] = re[i + k] - xr;
              im[i + k + len / 2] = im[i + k] - xi;
              re[i + k] += xr;
              im[i + k] += xi;
            }
          }
        }
      };
      for (let at = 0; at + N <= L.length; at += N * 4) {
        for (let i = 0; i < N; i++) {
          re[i] = ((L[at + i] + R[at + i]) / 2) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
          im[i] = 0;
        }
        fft();
        for (let k = 1; k < N / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
      }
      let num = 0;
      let den = 0;
      for (let k = 1; k < N / 2; k++) {
        num += ((k * sr) / N) * mag[k];
        den += mag[k];
      }
      // 16-bit stereo WAV, base64.
      const bytes = new Uint8Array(44 + L.length * 4);
      const v = new DataView(bytes.buffer);
      const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      str(0, "RIFF");
      v.setUint32(4, 36 + L.length * 4, true);
      str(8, "WAVEfmt ");
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true);
      v.setUint16(22, 2, true);
      v.setUint32(24, sr, true);
      v.setUint32(28, sr * 4, true);
      v.setUint16(32, 4, true);
      v.setUint16(34, 16, true);
      str(36, "data");
      v.setUint32(40, L.length * 4, true);
      for (let i = 0; i < L.length; i++) {
        v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
        v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
      }
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { peak, rms: Math.sqrt(sq / L.length), rms3: Math.sqrt(sq3 / (sr * 3)), step, centroid: den ? num / den : 0, nodes, wav: btoa(bin) };
    }, r);
    const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
    const file = join(out, `${r.name}.wav`);
    writeFileSync(file, Buffer.from(res.wav, "base64"));
    const under = db((res.peak * BUS) / RIFLE);
    const ok = res.rms > 0.004 && res.peak < 0.6 && under <= -9 && res.nodes <= 40;
    if (!ok) failed++;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${r.name.padEnd(13)} ${db(res.rms).toFixed(1).padStart(7)}  ${db(res.peak).toFixed(1).padStart(8)}  ${res.peak.toFixed(3)}  ${under.toFixed(1).padStart(10)} dB     ${Math.round(res.centroid)
        .toString()
        .padStart(6)}       ${db(res.rms3).toFixed(1).padStart(6)}   nodes ${res.nodes}  max step ${res.step.toFixed(3)}  ${file}`,
    );
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
