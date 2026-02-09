import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import os from "os";
import { MinerConfig, CORE_CONTRACT, TOKEN_CONTRACT, selectRpc, loadConfig } from "./config";
import { ChainClient } from "./chain";
import { AIEngine } from "./ai";
import { Solver, SolverProgress } from "./solver";
import { ethers } from "ethers";
import { checkForUpdates, getVersion } from "./updater";

const PORT = 3000;

/**
 * Web-based Mining Agent.
 * Provides a browser UI for configuration and monitoring,
 * while running all mining computation locally (CPU + AI).
 */

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Mining state
let miningActive = false;
let currentWs: WebSocket | null = null;
let chain: ChainClient | null = null;
let ai: AIEngine | null = null;
let solver: Solver | null = null;
let shouldStop = false;

/** Last known stats for GET /api/status (updated during mining) */
const lastApiStats: {
  blocksMined: number;
  bnbBalance: string;
  tokenBalance: string;
  hashRate: string;
} = {
  blocksMined: 0,
  bnbBalance: "0",
  tokenBalance: "0",
  hashRate: "0",
};

/**
 * Send a message to the connected WebSocket client
 */
function send(ws: WebSocket, type: string, data: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

/**
 * Send a log message to the client
 */
function log(ws: WebSocket, message: string) {
  send(ws, "log", { message });
}

/**
 * Generate fast local texts for instant mining start
 */
function generateLocalTexts(seed: string, count: number): string[] {
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    texts.push(
      `PoAIW mining candidate ${i} seed:${seed.slice(0, 18)} ` +
      `ts:${Date.now()} entropy:${Math.random().toString(36).slice(2)}` +
      `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)} ` +
      `Proof of AI Work combines artificial intelligence with cryptographic computation ` +
      `to create a novel mining paradigm where intelligence is the new hashrate.`
    );
  }
  return texts;
}

/**
 * Main mining loop (runs in background)
 */
async function mineLoop(ws: WebSocket, config: MinerConfig) {
  miningActive = true;
  shouldStop = false;

  chain = new ChainClient(config);
  ai = new AIEngine(config.openaiKey, config.aiModel);
  solver = new Solver(config.workers, config.maxNoncePerText);

  let currentChallengeNumber = 0n;
  let challengePreempted = false;
  let lastSeenBlock = 0n;

  // Event listener for preemption
  chain.onSolutionFound((miner, challengeNum) => {
    if (challengeNum <= lastSeenBlock) return;
    lastSeenBlock = challengeNum;

    if (miner.toLowerCase() !== chain!.address.toLowerCase()) {
      log(ws, `{yellow-fg}[NET]{/yellow-fg} Block #${challengeNum} solved by ${miner.slice(0, 8)}...`);
      if (challengeNum === currentChallengeNumber) {
        challengePreempted = true;
        solver?.stop();
        log(ws, `{yellow-fg}[SWITCH]{/yellow-fg} Challenge preempted, switching to next...`);
      }
    }
  });

  send(ws, "stats", { status: "Connecting..." });

  // Update balances and lastApiStats for GET /api/status
  async function updateBalances() {
    try {
      const [tokenBal, bnbBal, stats, totalSolutions] = await Promise.all([
        chain!.getTokenBalance(),
        chain!.getBnbBalance(),
        chain!.getMinerStats(),
        chain!.getTotalSolutions(),
      ]);
      const totalMined = parseFloat(ethers.formatEther(tokenBal)).toFixed(2);
      const bnbStr = parseFloat(ethers.formatEther(bnbBal)).toFixed(4);
      const blocks = Number(stats.solutions);
      lastApiStats.tokenBalance = totalMined;
      lastApiStats.bnbBalance = bnbStr;
      lastApiStats.blocksMined = blocks;
      send(ws, "stats", {
        totalMined,
        bnbBalance: bnbStr,
        blocksMined: blocks,
        networkSolutions: Number(totalSolutions),
      });
    } catch {}
  }

  await updateBalances();

  while (!shouldStop) {
    try {
      // Check paused
      try {
        if (await chain.isPaused()) {
          send(ws, "stats", { status: "Contract PAUSED" });
          log(ws, `{red-fg}[PAUSED]{/red-fg} Mining contract is paused. Waiting 30s...`);
          await sleep(30000);
          continue;
        }
      } catch {}

      // Fetch challenge
      send(ws, "stats", { status: "Fetching challenge..." });
      const challenge = await chain.getCurrentChallenge();
      currentChallengeNumber = challenge.challengeNumber;
      challengePreempted = false;

      const halvingInterval = 210_000n;
      const untilHalving = halvingInterval - ((challenge.challengeNumber - 1n) % halvingInterval);

      send(ws, "stats", {
        challengeNumber: challenge.challengeNumber.toString(),
        difficulty: formatDifficulty(challenge.difficulty),
        reward: ethers.formatEther(challenge.reward),
        status: "MINING (fast start)",
      });

      log(ws, `{cyan-fg}[NEW]{/cyan-fg} Challenge #${challenge.challengeNumber} | Diff: ${formatDifficulty(challenge.difficulty)}`);

      // Pipeline: start immediately with local texts
      const localTexts = generateLocalTexts(
        challenge.seed,
        Math.max(2, Math.floor(config.workers / 2))
      );
      log(ws, `{green-fg}[FAST]{/green-fg} Instant start with ${localTexts.length} local texts`);

      // AI in background
      const aiPromise = ai.generateCandidates(challenge.seed, config.aiBatchSize).catch(() => [] as string[]);

      // Solve with local texts
      const firstResult = await solver.solve(
        challenge.seed,
        challenge.challengeNumber,
        chain.address,
        localTexts,
        challenge.difficultyTarget,
        (p: SolverProgress) => {
          lastApiStats.hashRate = String(p.hashRate);
          send(ws, "stats", { hashRate: p.hashRate, noncesTried: p.tried });
        }
      );

      if (shouldStop) break;
      if (challengePreempted) { log(ws, `{yellow-fg}[SKIP]{/yellow-fg} Preempted`); continue; }

      if (firstResult.found && firstResult.solution && firstResult.nonce !== undefined) {
        await submitSolution(ws, chain, challenge, firstResult, config.gasLimit);
        await updateBalances();
        continue;
      }

      // Try AI texts
      const aiTexts = await aiPromise;
      if (shouldStop) break;
      if (challengePreempted) { log(ws, `{yellow-fg}[SKIP]{/yellow-fg} Preempted`); continue; }

      if (aiTexts.length > 0) {
        send(ws, "stats", { status: "MINING (AI boost)" });
        log(ws, `{magenta-fg}[AI]{/magenta-fg} Boosting with ${aiTexts.length} AI texts`);

        const aiResult = await solver.solve(
          challenge.seed,
          challenge.challengeNumber,
          chain.address,
          aiTexts,
          challenge.difficultyTarget,
          (p: SolverProgress) => {
            lastApiStats.hashRate = String(p.hashRate);
            send(ws, "stats", {
              hashRate: p.hashRate,
              noncesTried: firstResult.totalTried + p.tried,
            });
          }
        );

        if (shouldStop) break;
        if (challengePreempted) { log(ws, `{yellow-fg}[SKIP]{/yellow-fg} Preempted`); continue; }

        if (aiResult.found && aiResult.solution && aiResult.nonce !== undefined) {
          await submitSolution(ws, chain, challenge, aiResult, config.gasLimit);
          await updateBalances();
          continue;
        }
      }

      log(ws, `{yellow-fg}[MISS]{/yellow-fg} No valid nonce found. Retrying...`);
      await sleep(500);
    } catch (err: any) {
      log(ws, `{red-fg}[ERR]{/red-fg} ${err.message?.slice(0, 80)}`);
      send(ws, "stats", { status: "Error - Retrying..." });
      await sleep(5000);
    }
  }

  // Cleanup
  chain.removeAllListeners();
  solver.stop();
  miningActive = false;
  send(ws, "stats", { status: "Stopped" });
}

async function submitSolution(
  ws: WebSocket,
  chain: ChainClient,
  challenge: any,
  result: any,
  gasLimit: number
) {
  log(ws, `{green-fg}[FOUND]{/green-fg} Valid hash! Nonce: ${result.nonce}`);
  send(ws, "stats", { status: "Verifying..." });

  const stillOpen = await chain.isChallengeOpen(challenge.challengeNumber);
  if (!stillOpen) {
    log(ws, `{yellow-fg}[LATE]{/yellow-fg} Already solved. Skipping.`);
    return;
  }

  send(ws, "stats", { status: "Submitting (0.001 BNB)..." });
  try {
    const receipt = await chain.submitSolution(result.solution, result.nonce, gasLimit);
    if (receipt && receipt.status === 1) {
      log(ws, `{green-fg}[BLOCK]{/green-fg} Solution accepted! Tx: ${receipt.hash.slice(0, 16)}...`);
    } else {
      log(ws, `{red-fg}[FAIL]{/red-fg} Transaction failed.`);
    }
  } catch (err: any) {
    const msg = err.message?.slice(0, 80) || "Unknown";
    if (msg.includes("already solved")) {
      log(ws, `{yellow-fg}[RACE]{/yellow-fg} Another miner submitted first.`);
    } else {
      log(ws, `{red-fg}[TX ERR]{/red-fg} ${msg}`);
    }
  }
}

function formatDifficulty(d: bigint): string {
  if (d >= 1_000_000_000n) return (Number(d) / 1e9).toFixed(2) + "G";
  if (d >= 1_000_000n) return (Number(d) / 1e6).toFixed(2) + "M";
  if (d >= 1_000n) return (Number(d) / 1e3).toFixed(2) + "K";
  return d.toString();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ======================== HTTP API (for OpenClaw / automation) ========================

app.get("/api/status", (_req, res) => {
  const config = loadConfig();
  if (!config) {
    res.status(503).json({
      miningActive: false,
      error: "Not configured. Run init (e.g. ai-mine init --from-env) first.",
    });
    return;
  }
  res.json({
    miningActive,
    blocksMined: lastApiStats.blocksMined,
    bnbBalance: lastApiStats.bnbBalance,
    tokenBalance: lastApiStats.tokenBalance,
    hashRate: lastApiStats.hashRate,
  });
});

app.post("/api/start", (_req, res) => {
  const config = loadConfig();
  if (!config) {
    res.status(503).json({
      error: "Not configured. Run init (e.g. ai-mine init --from-env) first.",
    });
    return;
  }
  if (miningActive) {
    res.status(409).json({ error: "Mining already active." });
    return;
  }
  // Dummy WebSocket so mineLoop can run without a real client
  const fakeWs = {
    readyState: 1,
    send: (_data: string) => {},
  } as unknown as WebSocket;
  currentWs = fakeWs as WebSocket;
  mineLoop(fakeWs as WebSocket, config).catch((err) => {
    console.error("[api] mineLoop error:", err?.message || err);
  });
  res.json({ ok: true, message: "Mining started." });
});

app.post("/api/stop", (_req, res) => {
  shouldStop = true;
  solver?.stop();
  res.json({ ok: true });
});

// ======================== WebSocket Handler ========================

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "start" && !miningActive) {
        const c = msg.config;
        const config: MinerConfig = {
          rpcUrl: selectRpc(c.customRpc),
          privateKey: c.privateKey,
          coreContract: CORE_CONTRACT,
          tokenContract: TOKEN_CONTRACT,
          openaiKey: c.openaiKey,
          aiModel: c.aiModel || "gpt-4o-mini",
          aiBatchSize: c.aiBatch || 8,
          workers: c.workers || Math.max(1, os.cpus().length - 1),
          gasLimit: 500000,
          maxNoncePerText: 20000000,
        };

        currentWs = ws;
        mineLoop(ws, config);
      }

      if (msg.type === "stop") {
        shouldStop = true;
        solver?.stop();
      }
    } catch {}
  });

  ws.on("close", () => {
    if (ws === currentWs) {
      shouldStop = true;
      solver?.stop();
      currentWs = null;
    }
  });
});

// ======================== Start Server ========================

server.listen(PORT, () => {
  console.log(`
  \x1b[36m╔══════════════════════════════════════════════╗\x1b[0m
  \x1b[36m║\x1b[0m   \x1b[1;37mAI Mine — Web Mining Interface\x1b[0m             \x1b[36m║\x1b[0m
  \x1b[36m║\x1b[0m   \x1b[90mVersion ${getVersion()}\x1b[0m                            \x1b[36m║\x1b[0m
  \x1b[36m╚══════════════════════════════════════════════╝\x1b[0m

  Open in your browser: \x1b[1;36mhttp://localhost:${PORT}\x1b[0m
  `);
});
