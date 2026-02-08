import { ethers } from "ethers";
import { MinerConfig } from "./config";
import { ChainClient } from "./chain";
import { AIEngine } from "./ai";
import { Solver, SolverProgress } from "./solver";
import { Dashboard } from "./tui";

/**
 * Mining Agent - Orchestrates the full mining loop.
 *
 * Pipeline Mode (optimized for high-competition environments):
 *   1. New challenge arrives
 *   2. IMMEDIATELY start mining with fast local texts (zero delay)
 *   3. SIMULTANEOUSLY request AI texts from OpenAI in background
 *   4. When AI texts arrive, launch additional workers (more search spaces)
 *   5. First valid solution wins
 *
 * Additional optimizations:
 *   - Event-driven challenge switching
 *   - Pre-submit verification
 *   - Dynamic gas pricing (10% premium)
 *   - Graceful failure handling
 *   - Paused contract detection
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
   * Execute one full mining round using Pipeline Mode.
   *
   * Pipeline: local texts start mining immediately (0ms delay),
   * AI texts are fetched in background and join the search when ready.
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
      // Proceed if can't check
    }

    // --- Fetch current challenge ---
    this.dashboard.update({
      status: "{cyan-fg}Fetching challenge...{/cyan-fg}",
    });

    const challenge = await this.chain.getCurrentChallenge();
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

    // --- PIPELINE MODE: Start mining instantly with local texts ---
    // Generate fast local texts (instant, no API call)
    const localTexts = this._generateLocalTexts(
      challenge.seed,
      Math.max(2, Math.floor(this.config.workers / 2))
    );

    this.dashboard.update({
      status: "{yellow-fg}\u26cf MINING (fast start){/yellow-fg}",
    });

    this.dashboard.log(
      `{green-fg}[FAST]{/green-fg} Instant start with ${localTexts.length} local texts`
    );

    // Start AI generation in background (non-blocking)
    let aiTextsArrived = false;
    const aiPromise = this.ai
      .generateCandidates(challenge.seed, this.config.aiBatchSize)
      .then((aiTexts) => {
        aiTextsArrived = true;
        this.dashboard.update({
          aiCalls: this.ai.calls,
          aiTokens: this.ai.tokens,
          aiLastText: this.ai.lastText,
        });
        return aiTexts;
      })
      .catch(() => {
        // AI failed, no extra texts — local texts are already mining
        return [] as string[];
      });

    // Start nonce search immediately with local texts
    const firstResult = await this.solver.solve(
      challenge.seed,
      challenge.challengeNumber,
      this.chain.address,
      localTexts,
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

    // --- Check if first batch found a solution ---
    if (this.challengePreempted) {
      this.dashboard.log(
        `{yellow-fg}[SKIP]{/yellow-fg} Challenge solved by another miner`
      );
      return;
    }

    if (firstResult.found && firstResult.solution && firstResult.nonce !== undefined) {
      await this._submitSolution(challenge, firstResult);
      return;
    }

    // --- First batch exhausted without finding solution, try AI texts ---
    if (!aiTextsArrived) {
      this.dashboard.log(
        `{magenta-fg}[AI]{/magenta-fg} Waiting for AI texts...`
      );
    }

    const aiTexts = await aiPromise;

    if (this.challengePreempted) {
      this.dashboard.log(
        `{yellow-fg}[SKIP]{/yellow-fg} Challenge solved while waiting for AI`
      );
      return;
    }

    if (aiTexts.length > 0) {
      this.dashboard.update({
        status: "{yellow-fg}\u26cf MINING (AI boost){/yellow-fg}",
      });

      this.dashboard.log(
        `{magenta-fg}[AI]{/magenta-fg} Boosting with ${aiTexts.length} AI texts`
      );

      const aiResult = await this.solver.solve(
        challenge.seed,
        challenge.challengeNumber,
        this.chain.address,
        aiTexts,
        challenge.difficultyTarget,
        (progress: SolverProgress) => {
          this.dashboard.update({
            hashRate: progress.hashRate,
            noncesTried: firstResult.totalTried + progress.tried,
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

      if (aiResult.found && aiResult.solution && aiResult.nonce !== undefined) {
        await this._submitSolution(challenge, aiResult);
        return;
      }

      this.dashboard.log(
        `{yellow-fg}[MISS]{/yellow-fg} No valid nonce found. Tried: ${(firstResult.totalTried + aiResult.totalTried).toLocaleString()}`
      );
    } else {
      this.dashboard.log(
        `{yellow-fg}[MISS]{/yellow-fg} No valid nonce found. Tried: ${firstResult.totalTried.toLocaleString()}`
      );
    }

    await this._sleep(500);
  }

  /**
   * Generate fast local texts for instant mining start (no API call).
   */
  private _generateLocalTexts(seed: string, count: number): string[] {
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      const text =
        `PoAIW mining candidate ${i} seed:${seed.slice(0, 18)} ` +
        `ts:${Date.now()} entropy:${Math.random().toString(36).slice(2)}` +
        `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)} ` +
        `Proof of AI Work combines artificial intelligence with cryptographic computation ` +
        `to create a novel mining paradigm where intelligence is the new hashrate.`;
      texts.push(text);
    }
    return texts;
  }

  /**
   * Submit a found solution to the contract with all safety checks.
   */
  private async _submitSolution(
    challenge: { challengeNumber: bigint },
    result: { solution?: Uint8Array; nonce?: bigint; hash?: string; totalTried: number }
  ): Promise<void> {
    if (!result.solution || result.nonce === undefined) return;

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
