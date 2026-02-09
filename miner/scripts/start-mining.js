#!/usr/bin/env node
/**
 * One-shot script for OpenClaw / automation: start web server if not running,
 * then POST /api/start. Run from miner dir: node scripts/start-mining.js
 * Or set AIMINE_DIR to repo root (e.g. ~/PoAIW), then run from anywhere.
 * All comments and output in English.
 */

const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 3000;
const HOST = "127.0.0.1";

function minerRoot() {
  const base = process.env.AIMINE_DIR
    ? path.join(process.env.AIMINE_DIR, "miner")
    : path.join(
        process.env.HOME || process.env.USERPROFILE || "",
        "PoAIW",
        "miner"
      );
  return path.resolve(base);
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, HOST);
  });
}

function startWebInBackground(root) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "web"], {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    child.on("error", reject);
    // Give it a moment to bind
    setTimeout(() => resolve(), 500);
  });
}

function postStart() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: "/api/start",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": body.length },
      },
      (res) => {
        let data = "";
        res.on("data", (ch) => (data += ch));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode });
          } else {
            reject(new Error(`API returned ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const root = minerRoot();
  const inUse = await isPortInUse(PORT);
  if (!inUse) {
    try {
      await startWebInBackground(root);
    } catch (e) {
      console.error("Failed to start web:", e.message);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  try {
    await postStart();
    console.log("Mining started.");
  } catch (e) {
    console.error("Failed to start mining:", e.message);
    process.exit(1);
  }
}

main();
