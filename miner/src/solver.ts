import { Worker } from "worker_threads";
import { ethers } from "ethers";
import path from "path";

/**
 * Solution result from the solver
 */
export interface SolutionResult {
  found: boolean;
  solution?: Uint8Array;
  nonce?: bigint;
  hash?: string;
  textIndex?: number;
  totalTried: number;
}

/**
 * Solver progress callback data
 */
export interface SolverProgress {
  tried: number;
  hashRate: number;
  activeWorkers: number;
  lastHash?: string;
}

/**
 * Multi-threaded puzzle solver.
 * Distributes nonce search across CPU worker threads.
 */
export class Solver {
  private workerCount: number;
  private maxNoncePerText: number;
  private workers: Worker[] = [];
  private _isRunning = false;

  constructor(workerCount: number, maxNoncePerText: number) {
    this.workerCount = workerCount;
    this.maxNoncePerText = maxNoncePerText;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Search for a valid nonce across multiple candidate texts.
   * Hash format: keccak256(seed, challengeNumber, minerAddress, keccak256(solution), nonce)
   *
   * @param seed - Current challenge seed (bytes32)
   * @param challengeNumber - Current challenge number
   * @param minerAddress - Miner's wallet address
   * @param candidateTexts - Array of AI-generated candidate texts
   * @param difficultyTarget - Hash must be below this value
   * @param onProgress - Callback for progress updates
   */
  async solve(
    seed: string,
    challengeNumber: bigint,
    minerAddress: string,
    candidateTexts: string[],
    difficultyTarget: bigint,
    onProgress?: (progress: SolverProgress) => void
  ): Promise<SolutionResult> {
    this._isRunning = true;
    this.workers = [];

    const targetHex = "0x" + difficultyTarget.toString(16);
    let totalTried = 0;
    const hashRates: number[] = [];

    return new Promise((resolve) => {
      let resolved = false;
      let completedWorkers = 0;

      // Use all workers: distribute texts round-robin across workers
      const totalWorkers = this.workerCount;

      for (let i = 0; i < totalWorkers; i++) {
        const textIdx = i % candidateTexts.length;
        const text = candidateTexts[textIdx];
        const solutionBytes = ethers.toUtf8Bytes(text);
        const solutionHash = ethers.keccak256(solutionBytes);

        // Build prefix: abi.encodePacked(seed, challengeNumber, minerAddress, solutionHash)
        // = bytes32(32) + uint256(32) + address(20) + bytes32(32) = 116 bytes
        const prefix = this._buildPrefix(
          seed,
          challengeNumber,
          minerAddress,
          solutionHash
        );

        // Randomized nonce starting point for fair competition.
        // Each miner starts at a different random offset in the nonce space,
        // so slower miners can still win by luck (probabilistic mining).
        const randomOffset = Math.floor(Math.random() * 2_000_000_000);

        // Split nonce range across workers working on the same text
        const workersPerText = Math.max(
          1,
          Math.floor(totalWorkers / candidateTexts.length)
        );
        const subIndex = Math.floor(i / candidateTexts.length);
        const nonceRange = Math.floor(this.maxNoncePerText / workersPerText);
        const nonceStart = randomOffset + subIndex * nonceRange;
        const nonceEnd = nonceStart + nonceRange;

        const ext = __filename.endsWith(".ts") ? "worker.ts" : "worker.js";
        const workerPath = path.join(__dirname, ext);

        const worker = new Worker(workerPath, {
          workerData: {
            prefix: Array.from(prefix),
            nonceStart,
            nonceEnd,
            targetHex,
            textIndex: textIdx,
          },
          execArgv: __filename.endsWith(".ts")
            ? ["--require", "ts-node/register"]
            : [],
        });

        this.workers.push(worker);

        worker.on("message", (msg) => {
          if (resolved) return;

          if (msg.found) {
            resolved = true;
            this._isRunning = false;
            this.stop();

            resolve({
              found: true,
              solution: solutionBytes,
              nonce: BigInt(msg.nonce),
              hash: msg.hash,
              textIndex: msg.textIndex,
              totalTried: totalTried + (msg.tried || 0),
            });
          } else {
            // Progress update — msg.tried is a delta
            totalTried += msg.tried || 0;
            if (msg.hashRate) hashRates[i] = msg.hashRate;

            const aggregateRate = hashRates.reduce(
              (a, b) => a + (b || 0),
              0
            );
            onProgress?.({
              tried: totalTried,
              hashRate: aggregateRate,
              activeWorkers: this.workers.length - completedWorkers,
              lastHash: msg.lastHash,
            });

            if (msg.done) {
              completedWorkers++;
              if (completedWorkers >= totalWorkers && !resolved) {
                resolved = true;
                this._isRunning = false;
                resolve({ found: false, totalTried });
              }
            }
          }
        });

        worker.on("error", (err: Error) => {
          console.error(`Worker ${i} error:`, err.message);
          completedWorkers++;
          if (completedWorkers >= totalWorkers && !resolved) {
            resolved = true;
            this._isRunning = false;
            resolve({ found: false, totalTried });
          }
        });
      }
    });
  }

  /**
   * Stop all running workers
   */
  stop(): void {
    this._isRunning = false;
    for (const worker of this.workers) {
      try {
        worker.terminate();
      } catch {
        // Worker may already be terminated
      }
    }
    this.workers = [];
  }

  /**
   * Build prefix bytes for: abi.encodePacked(seed, challengeNumber, address, solutionHash)
   * Format: bytes32(32) + uint256(32) + address(20) + bytes32(32) = 116 bytes
   */
  private _buildPrefix(
    seed: string,
    challengeNumber: bigint,
    minerAddress: string,
    solutionHash: string
  ): Buffer {
    const buf = Buffer.alloc(116);

    // seed as bytes32 (32 bytes)
    Buffer.from(seed.slice(2), "hex").copy(buf, 0);

    // challengeNumber as uint256 (32 bytes, big-endian)
    const cnHex = challengeNumber.toString(16).padStart(64, "0");
    Buffer.from(cnHex, "hex").copy(buf, 32);

    // minerAddress as address (20 bytes)
    const addrHex = minerAddress.slice(2).toLowerCase();
    Buffer.from(addrHex, "hex").copy(buf, 64);

    // solutionHash as bytes32 (32 bytes)
    const hashHex = solutionHash.slice(2);
    Buffer.from(hashHex, "hex").copy(buf, 84);

    return buf;
  }
}
