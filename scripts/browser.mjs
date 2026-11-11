// The headless browser the smoke and end-to-end scripts use. It runs Chrome or Chromium through playwright-core
// (a dev dependency), on any machine:
//   CHROME_PATH=/path/to/chrome   use this browser
//   otherwise                     the usual install path for this OS, if it exists
//   otherwise                     playwright's own Chromium (npx playwright-core install chromium)
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const DEFAULTS = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
};

export function launch() {
  const executablePath = process.env.CHROME_PATH || (DEFAULTS[process.platform] || []).find((p) => existsSync(p));
  // WebGL needs a GPU path in headless mode: Metal through ANGLE on macOS, SwiftShader elsewhere.
  const gl = process.platform === "darwin" ? ["--use-angle=metal"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  return chromium.launch({ executablePath, headless: true, args: [...gl, "--ignore-gpu-blocklist", "--enable-gpu"] });
}
