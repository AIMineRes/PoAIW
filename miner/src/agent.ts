import { ethers } from "ethers";
import { MinerConfig } from "./config";
import { ChainClient } from "./chain";
import { AIEngine } from "./ai";
import { Solver, SolverProgress } from "./solver";
import { Dashboard } from "./tui";

/**
 * Mining Agent - Orchestrates the full mining loop.
 *
 * Optimizations for multi-miner competition:
 * 1. Event-driven challenge switching — stops work when someone else solves
 * 2. Pre-submit verification — checks challenge is still open before sending tx
 * 3. Dynamic gas pricing — 10% premium for faster tx inclusion
 * 4. Failure retry — automatically moves to next challenge on revert
 * 5. Paused check — skips mining if contract is paused
 */
export class MiningAgent {
  private config: MinerConfig;
  private chain: ChainClient;
  private ai: AIEngine;
  private solver: Solver;
  private dashboard: Dashboard;
  private running = false;

  // Track current challenge for fast preemption
  private currentChallengeNumber: bigint = 0n;
  private challengePreempted = false;

  constructor(config: MinerConfig) {
    this.config = config;
    this.chain = new ChainClient(config);
    this.ai = new AIEngine(config.openaiKey, config.aiModel);
    this.solver = new Solver(config.workers, config.maxNoncePerText);
    this.dashboard = new Dashboard();
  }

  /**
   * Start the mining agent main loop
   */
  async start(): Promise<void> {
    this.running = true;

    this.dashboard.update({
      aiModel: this.config.aiModel,
      workers: this.config.workers,
      minerAddress: this.chain.address,
      status: "{cyan-fg}Connecting...{/cyan-fg}",
    });

    await this._updateBalances();

    // Event listener: detect when another miner solves the challenge
    this.chain.onSolutionFound((miner, challengeNum) => {
      if (miner.toLowerCase() !== this.chain.address.toLowerCase()) {
        this.dashboard.log(
          `{yellow-fg}[NET]{/yellow-fg} Block #${challengeNum} solved by ${miner.slice(0, 8)}...`
        );
        // Preempt if we're working on this challenge
        if (challengeNum === this.currentChallengeNumber) {
          this.challengePreempted = true;
          this.solver.stop();
          this.dashboard.log(
            `{yellow-fg}[SWITCH]{/yellow-fg} Challenge preempted, switching to next...`
          );
        }
      }
    });

    // Main mining loop
    while (this.running) {
      try {
        await this._mineRound();
      } catch (error: any) {
        this.dashboard.log(
          `{red-fg}[ERR]{/red-fg} ${error.message?.slice(0, 80)}`
        );
        this.dashboard.update({
          status: "{red-fg}Error - Retrying in 5s...{/red-fg}",
        });
        await this._sleep(5000);
      }
    }
  }

  /**
   * Execute one full mining round
   */
  private async _mineRound(): Promise<void> {
    // --- Check if contract is paused ---
    try {
      const paused = await this.chain.isPaused();
      if (paused) {
        this.dashboard.update({
          status: "{red-fg}Contract PAUSED{/red-fg}",
        });
        this.dashboard.log(
          `{red-fg}[PAUSED]{/red-fg} Mining contract is paused. Waiting 30s...`
        );
        await this._sleep(30000);
        return;
      }
    } catch {
      // If we can't check paused state, proceed anyway
    }

    // --- Fetch current challenge ---
    this.dashboard.update({
      status: "{cyan-fg}Fetching challenge...{/cyan-fg}",
    });

    const challenge = await this.chain.getCurrentChallenge();

    // Reset preemption flag AFTER updating challenge number (fixes race condition)
    this.currentChallengeNumber = challenge.challengeNumber;
    this.challengePreempted = false;

    const halvingInterval = 210_000n;
    const challengesUntilHalving =
      halvingInterval - ((challenge.challengeNumber - 1n) % halvingInterval);

    this.dashboard.update({
      challengeNumber: challenge.challengeNumber.toString(),
      difficulty: this._formatDifficulty(challenge.difficulty),
      seed: challenge.seed.slice(0, 18) + "...",
      reward: ethers.formatEther(challenge.reward),
      nextHalving: `${challengesUntilHalving.toLocaleString()} blocks`,
    });

    this.dashboard.log(
      `{cyan-fg}[NEW]{/cyan-fg} Challenge #${challenge.challengeNumber} | Diff: ${this._formatDifficulty(challenge.difficulty)}`
    );

    // --- Generate AI candidate texts ---
    this.dashboard.update({
      status: "{magenta-fg}AI generating texts...{/magenta-fg}",
    });

    const candidates = await this.ai.generateCandidates(
      challenge.seed,
      this.config.aiBatchSize
    );

    this.dashboard.update({
      aiCalls: this.ai.calls,
      aiTokens: this.ai.tokens,
      aiLastText: this.ai.lastText,
    });

    this.dashboard.log(
      `{magenta-fg}[AI]{/magenta-fg} Generated ${candidates.length} candidate texts`
    );

    if (this.challengePreempted) {
      this.dashboard.log(
        `{yellow-fg}[SKIP]{/yellow-fg} Challenge solved during AI generation`
      );
      return;
    }

    // --- CPU nonce search (now includes seed in hash) ---
    this.dashboard.update({
      status: "{yellow-fg}\u26cf MINING{/yellow-fg}",
    });

    const result = await this.solver.solve(
      challenge.seed,
      challenge.challengeNumber,
      this.chain.address,
      candidates,
      challenge.difficultyTarget,
      (progress: SolverProgress) => {
        this.dashboard.update({
          hashRate: progress.hashRate,
          noncesTried: progress.tried,
        });
        if (progress.tried % 200000 === 0 && progress.tried > 0) {
          const sampleHash =
            "0x" +
            Array.from({ length: 8 }, () =>
              Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
            ).join("");
          this.dashboard.logHash(sampleHash + "0".repeat(48), false);
        }
      }
    );

    if (this.challengePreempted) {
      this.dashboard.log(
        `{yellow-fg}[SKIP]{/yellow-fg} Challenge solved by another miner`
      );
      return;
    }

    // --- Handle result ---
    if (result.found && result.solution && result.nonce !== undefined) {
      this.dashboard.logHash(result.hash!, true);
      this.dashboard.log(
        `{green-fg}[FOUND]{/green-fg} Valid hash! Nonce: ${result.nonce} | Tried: ${result.totalTried.toLocaleString()}`
      );

      // Pre-submit verification
      this.dashboard.update({
        status: "{green-fg}Verifying challenge...{/green-fg}",
      });

      const stillOpen = await this.chain.isChallengeOpen(
        challenge.challengeNumber
      );

      if (!stillOpen) {
        this.dashboard.log(
          `{yellow-fg}[LATE]{/yellow-fg} Challenge already solved. Skipping.`
        );
        return;
      }

      // Submit with protocol fee
      this.dashboard.update({
        status: "{green-fg}Submitting (0.001 BNB fee)...{/green-fg}",
      });

      try {
        const receipt = await this.chain.submitSolution(
          result.solution,
          result.nonce,
          this.config.gasLimit
        );

        if (receipt && receipt.status === 1) {
          this.dashboard.log(
            `{bold}{green-fg}[BLOCK]{/green-fg}{/bold} Solution accepted! Tx: ${receipt.hash.slice(0, 16)}...`
          );
          await this._updateBalances();
        } else {
          this.dashboard.log(
            `{red-fg}[FAIL]{/red-fg} Transaction failed. Moving on.`
          );
        }
      } catch (error: any) {
        const msg = error.message?.slice(0, 80) || "Unknown error";
        if (msg.includes("already solved")) {
          this.dashboard.log(
            `{yellow-fg}[RACE]{/yellow-fg} Another miner submitted first.`
          );
        } else {
          this.dashboard.log(`{red-fg}[TX ERR]{/red-fg} ${msg}`);
        }
      }
    } else {
      this.dashboard.log(
        `{yellow-fg}[MISS]{/yellow-fg} No valid nonce in range. Tried: ${result.totalTried.toLocaleString()}`
      );
    }

    await this._sleep(1000);
  }

  /**
   * Update balance displays
   */
  private async _updateBalances(): Promise<void> {
    try {
      const [tokenBal, bnbBal, stats, totalSolutions, tokenSupply] =
        await Promise.all([
          this.chain.getTokenBalance(),
          this.chain.getBnbBalance(),
          this.chain.getMinerStats(),
          this.chain.getTotalSolutions(),
          this.chain.getTokenTotalSupply(),
        ]);

      this.dashboard.update({
        totalMined: parseFloat(ethers.formatEther(tokenBal)).toFixed(2),
        bnbBalance: parseFloat(ethers.formatEther(bnbBal)).toFixed(4),
        blocksMined: Number(stats.solutions),
        networkSolutions: Number(totalSolutions),
        networkTotalMined: parseFloat(ethers.formatEther(tokenSupply)).toFixed(2),
      });
    } catch {
      // Silently ignore
    }
  }

  private _formatDifficulty(difficulty: bigint): string {
    if (difficulty >= 1_000_000_000n)
      return (Number(difficulty) / 1_000_000_000).toFixed(2) + "G";
    if (difficulty >= 1_000_000n)
      return (Number(difficulty) / 1_000_000).toFixed(2) + "M";
    if (difficulty >= 1_000n)
      return (Number(difficulty) / 1_000).toFixed(2) + "K";
    return difficulty.toString();
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  stop(): void {
    this.running = false;
    this.solver.stop();
    this.chain.removeAllListeners();
    this.dashboard.destroy();
  }
}
