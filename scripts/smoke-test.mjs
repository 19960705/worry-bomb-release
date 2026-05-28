import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9339;
const baseUrl = `http://127.0.0.1:5194/`;
const outDir = new URL("../verification/", import.meta.url);
const profileDir = "/tmp/worry-bomb-release-chrome";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
};

const waitForDebugger = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await sleep(120);
    }
  }
  throw new Error("Chrome debugging port did not open");
};

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result);
        }
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }
}

const connect = async (webSocketDebuggerUrl) => {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return new CdpClient(socket);
};

const capture = async (client, name) => {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  await writeFile(new URL(`${name}.png`, outDir), Buffer.from(result.data, "base64"));
};

const mouse = async (client, type, x, y, button = "left") => {
  await client.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button,
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mousePressed" ? 1 : 0
  });
};

const click = async (client, x, y) => {
  await mouse(client, "mousePressed", x, y);
  await mouse(client, "mouseReleased", x, y);
};

const drag = async (client, fromX, fromY, toX, toY) => {
  await mouse(client, "mousePressed", fromX, fromY);
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await mouse(client, "mouseMoved", fromX + (toX - fromX) * t, fromY + (toY - fromY) * t);
    await sleep(24);
  }
  await mouse(client, "mouseReleased", toX, toY);
};

const clickSelector = async (client, selector) => {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    returnByValue: true
  });
  await click(client, result.result.value.x, result.result.value.y);
};

await mkdir(outDir, { recursive: true });
await rm(profileDir, { recursive: true, force: true });

const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "about:blank"
], { stdio: "ignore" });

try {
  await waitForDebugger();
  const tab = await fetchJson(`http://127.0.0.1:${port}/json/new?${baseUrl}`, { method: "PUT" });
  const client = await connect(tab.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  });
  await client.send("Page.navigate", { url: baseUrl });
  await sleep(1000);
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelector('#target-text').value = '坏情绪';
      document.querySelector('#pin-note-button').click();
    })()`
  });
  await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAXUlEQVR4nO3OMQEAIAzAsIF/z0NGHjQKejMzs7t76wG+3gTjDWEWI7xhjDCLEd4wRpjFCG8YI8xihDeMEWYxwhvGCIsR3jBGmMUIbxgjzGKEN4wRZjHCG8YIsxjhAzkKAaFYEwJKAAAAAElFTkSuQmCC';
      const blob = await fetch(dataUrl).then((response) => response.blob());
      const input = document.querySelector('#photo-input');
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'target.png', { type: 'image/png' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
    awaitPromise: true
  });
  await sleep(450);
  await capture(client, "desktop-initial");

  const targetCheck = await client.send("Runtime.evaluate", {
    expression: `document.querySelectorAll('.wall-target').length`,
    returnByValue: true
  });
  if (targetCheck.result.value < 2) {
    throw new Error(`Wall target setup failed: ${targetCheck.result.value}`);
  }

  await clickSelector(client, "#camera-button");
  await sleep(2200);
  const cameraCheck = await client.send("Runtime.evaluate", {
    expression: `document.querySelector('#camera-state')?.textContent`,
    returnByValue: true
  });
  if (!["摄像头已连接", "鼠标/触控模式"].includes(cameraCheck.result.value)) {
    throw new Error(`Camera flow check failed: ${cameraCheck.result.value}`);
  }
  await sleep(450);

  await drag(client, 640, 410, 930, 245);
  await sleep(880);
  await capture(client, "desktop-thrown-shatter");

  await sleep(1200);
  await clickSelector(client, "#smash-button");
  await sleep(900);
  await capture(client, "desktop-button-throw");

  const domCheck = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const canvas = document.querySelector('#game-canvas');
      const controls = [...document.querySelectorAll('button:not(.target-remove)')]
        .filter((button) => button.offsetParent !== null)
        .map((button) => button.getBoundingClientRect());
      return {
        title: document.querySelector('h1')?.textContent,
        count: document.querySelector('#release-count')?.textContent,
        canvas: { width: canvas.width, height: canvas.height },
        buttonsVisible: controls.every((rect) => rect.width > 36 && rect.height >= 40),
        targets: document.querySelectorAll('.wall-target').length,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
      };
    })()`,
    returnByValue: true
  });
  if (!domCheck.result.value?.buttonsVisible || domCheck.result.value?.overflowX) {
    throw new Error(`Desktop layout check failed: ${JSON.stringify(domCheck.result.value)}`);
  }
  if (domCheck.result.value.title !== "砸瓶解压" || Number(domCheck.result.value.count) < 1) {
    throw new Error(`Desktop game flow check failed: ${JSON.stringify(domCheck.result.value)}`);
  }

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });
  await client.send("Page.navigate", { url: baseUrl });
  await sleep(900);
  await capture(client, "mobile-initial");

  const mobileCheck = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const buttons = [...document.querySelectorAll('button:not(.target-remove)')]
        .filter((button) => button.offsetParent !== null)
        .map((button) => button.getBoundingClientRect());
      return {
        buttonsVisible: buttons.every((rect) => rect.width > 40 && rect.height >= 40),
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        bottomHeight: document.querySelector('.hud-bottom').getBoundingClientRect().height
      };
    })()`,
    returnByValue: true
  });
  if (!mobileCheck.result.value?.buttonsVisible || mobileCheck.result.value?.overflowX) {
    throw new Error(`Mobile layout check failed: ${JSON.stringify(mobileCheck.result.value)}`);
  }

  console.log("Smoke test passed");
} finally {
  chrome.kill("SIGTERM");
  await sleep(250);
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
