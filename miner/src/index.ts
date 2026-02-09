#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig, initConfig, writeEnvFromProcessEnv, writeEnvFromArgs } from "./config";
import { MiningAgent } from "./agent";
import { Dashboard } from "./tui";
import { ethers } from "ethers";
import { AIMINE_CORE_ABI, AIMINE_TOKEN_ABI } from "./abi";
import { checkForUpdates, getVersion } from "./updater";

/**
 * AI Mine - Proof of AI Work Mining Client
 *
 * Subcommands:
 *   init     - Interactive configuration wizard
 *   start    - Start mining
 *   balance  - Check wallet and token balances
 */

const program = new Command();

program
  .name("ai-mine")
  .description("AI-Powered Mining Client for AIMine on BNB Chain")
  .version(getVersion());

// ======================== init ========================

program
  .command("init")
  .description("Interactive configuration wizard or non-interactive (--from-env / --private-key)")
  .option("--from-env", "Write .env from process.env (PRIVATE_KEY, OPENAI_KEY); for OpenClaw / automation")
  .option("--private-key <key>", "Wallet private key (0x...); use with --openai-key for non-interactive")
  .option("--openai-key <key>", "OpenAI API key (sk-...)")
  .option("--ai-model <model>", "AI model (default: gpt-4o-mini)", "gpt-4o-mini")
  .option("--workers <n>", "CPU worker threads", (v) => parseInt(v, 10))
  .action(async (opts) => {
    if (opts.fromEnv) {
      const ok = writeEnvFromProcessEnv();
      if (!ok) {
        console.error("  Error: PRIVATE_KEY and OPENAI_KEY must be set in environment.");
        process.exit(1);
      }
      console.log("  Configuration written to .env from environment.");
      return;
    }
    if (opts.privateKey != null || opts.openaiKey != null) {
      if (!opts.privateKey || !opts.openaiKey) {
        console.error("  Error: Both --private-key and --openai-key are required.");
        process.exit(1);
      }
      try {
        writeEnvFromArgs({
          privateKey: opts.privateKey,
          openaiKey: opts.openaiKey,
          aiModel: opts.aiModel,
          workers: opts.workers,
        });
        console.log("  Configuration written to .env.");
      } catch (e: any) {
        console.error("  Error:", e.message);
        process.exit(1);
      }
      return;
    }
    console.log(Dashboard.showSplash());
    await initConfig();
  });

// ======================== start ========================

program
  .command("start")
  .description("Start the mining agent")
  .option("--workers <n>", "Override CPU worker thread count")
  .option("--ai-batch <n>", "Override AI texts per round")
  .option("--max-nonce <n>", "Override max nonce per text")
  .action(async (opts) => {
    // Show splash
    console.log(Dashboard.showSplash());

    // Check for updates (non-blocking)
    await checkForUpdates();

    // Load config from .env
    const config = loadConfig();
    if (!config) {
      console.log("  \x1b[31mError: No configuration found.\x1b[0m");
      console.log("  \x1b[90mRun \x1b[36mnpm run init\x1b[90m first to set up your wallet and API key.\x1b[0m");
      console.log("");
      process.exit(1);
    }

    // Apply CLI overrides
    if (opts.workers) config.workers = parseInt(opts.workers);
    if (opts.aiBatch) config.aiBatchSize = parseInt(opts.aiBatch);
    if (opts.maxNonce) config.maxNoncePerText = parseInt(opts.maxNonce);

    // Display startup info (never show actual RPC URL)
    const maskedKey = config.privateKey.slice(0, 6) + "..." + config.privateKey.slice(-4);
    const rpcDisplay = config.rpcUrl.includes("binance.org") || config.rpcUrl.includes("drpc")
      ? "Built-in (auto-selected)"
      : "Custom";
    console.log("  \x1b[90mNetwork:\x1b[0m      BNB Chain Mainnet");
    console.log("  \x1b[90mRPC:\x1b[0m          ", rpcDisplay);
    console.log("  \x1b[90mWallet:\x1b[0m       ", maskedKey);
    console.log("  \x1b[90mAI Model:\x1b[0m     ", config.aiModel);
    console.log("  \x1b[90mCPU Workers:\x1b[0m  ", config.workers);
    console.log("  \x1b[90mAI Batch:\x1b[0m     ", config.aiBatchSize);
    console.log("");
    console.log("  \x1b[32mStarting mining agent...\x1b[0m");
    console.log("");

    // Brief pause for readability
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Create and start mining agent
    const agent = new MiningAgent(config);

    const shutdown = () => {
      console.log("\n\x1b[33mShutting down mining agent...\x1b[0m");
      agent.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      await agent.start();
    } catch (error: any) {
      console.error("\x1b[31mFatal error:\x1b[0m", error.message);
      agent.stop();
      process.exit(1);
    }
  });

// ======================== balance ========================

program
  .command("balance")
  .description("Check your wallet balances and mining stats")
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.log("  \x1b[31mError: No configuration found.\x1b[0m");
      console.log("  \x1b[90mRun \x1b[36mnpm run init\x1b[90m first to set up your wallet and API key.\x1b[0m");
      console.log("");
      process.exit(1);
    }

    console.log("");
    console.log("  \x1b[1;36mAI Mine - Wallet & Mining Status\x1b[0m");
    console.log("  \x1b[90m─────────────────────────────────────\x1b[0m");
    console.log("");

    try {
      const provider = new ethers.JsonRpcProvider(config.rpcUrl);
      const wallet = new ethers.Wallet(config.privateKey, provider);

      const coreContract = new ethers.Contract(
        config.coreContract,
        AIMINE_CORE_ABI,
        provider
      );

      const tokenContract = new ethers.Contract(
        config.tokenContract,
        AIMINE_TOKEN_ABI,
        provider
      );

      // Fetch all data in parallel
      const [
        bnbBalance,
        tokenBalance,
        minerStats,
        challenge,
        totalSolutions,
      ] = await Promise.all([
        provider.getBalance(wallet.address),
        tokenContract.balanceOf(wallet.address),
        coreContract.getMinerStats(wallet.address),
        coreContract.getCurrentChallenge(),
        coreContract.totalSolutions(),
      ]);

      const halvingInterval = 210_000n;
      const challengeNum = challenge._challengeNumber;
      const untilHalving = halvingInterval - ((challengeNum - 1n) % halvingInterval);

      console.log("  \x1b[1mWallet\x1b[0m");
      console.log(`  Address:       \x1b[33m${wallet.address}\x1b[0m`);
      console.log(`  BNB Balance:   \x1b[37m${parseFloat(ethers.formatEther(bnbBalance)).toFixed(6)} BNB\x1b[0m`);
      console.log(`  AIT Balance:   \x1b[32m${parseFloat(ethers.formatEther(tokenBalance)).toFixed(4)} AIT\x1b[0m`);
      console.log("");
      console.log("  \x1b[1mMining Stats\x1b[0m");
      console.log(`  Blocks Mined:  \x1b[36m${minerStats.solutions.toString()}\x1b[0m`);
      console.log(`  Total Earned:  \x1b[32m${parseFloat(ethers.formatEther(minerStats.rewards)).toFixed(4)} AIT\x1b[0m`);
      console.log("");
      console.log("  \x1b[1mNetwork\x1b[0m");
      console.log(`  Challenge:     \x1b[37m#${challengeNum.toString()}\x1b[0m`);
      console.log(`  Difficulty:    \x1b[37m${challenge._difficulty.toString()}\x1b[0m`);
      console.log(`  Block Reward:  \x1b[32m${ethers.formatEther(challenge._reward)} AIT\x1b[0m`);
      console.log(`  Next Halving:  \x1b[90m${untilHalving.toString()} blocks\x1b[0m`);
      console.log(`  Total Blocks:  \x1b[90m${totalSolutions.toString()}\x1b[0m`);
      console.log("");
    } catch (error: any) {
      console.error("  \x1b[31mError:\x1b[0m", error.message);
      process.exit(1);
    }
  });

// ======================== Parse & Execute ========================

// Show help if no command provided
if (process.argv.length <= 2) {
  console.log(Dashboard.showSplash());
  program.help();
}

program.parse();
