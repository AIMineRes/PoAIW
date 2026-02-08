import { parentPort, workerData } from "worker_threads";
import { keccak256 } from "ethers";

/**
 * Worker thread for CPU-intensive nonce searching.
 *
 * Uses ethers.js keccak256 for Ethereum-compatible hashing.
 * Each worker receives a pre-computed prefix and searches a nonce range.
 *
 * Communication:
 * - Receives: { prefix, nonceStart, nonceEnd, targetHex, textIndex }
 * - Sends:    { found: true, nonce, hash, textIndex, tried } or
 *             { found: false, tried, textIndex, hashRate }
 */

interface WorkerInput {
  prefix: number[];        // Pre-encoded bytes: seed + challengeNumber + address + solutionHash
  nonceStart: number;      // Start of nonce range (inclusive)
  nonceEnd: number;        // End of nonce range (exclusive)
  targetHex: string;       // Difficulty target as hex string
  textIndex: number;       // Index of the candidate text
}

const data = workerData as WorkerInput;
const prefix = Buffer.from(data.prefix);
const target = BigInt(data.targetHex);
const { nonceStart, nonceEnd, textIndex } = data;

// Pre-allocate buffer: prefix (116 bytes) + nonce (32 bytes) = 148 bytes
const inputBuffer = Buffer.alloc(prefix.length + 32);
prefix.copy(inputBuffer, 0);

let found = false;
let tried = 0;
const startTime = Date.now();
const REPORT_INTERVAL = 50000;

for (let nonce = nonceStart; nonce < nonceEnd; nonce++) {
  // Write nonce as uint256 big-endian (32 bytes) at the end of buffer
  const nonceBig = BigInt(nonce);
  for (let i = 31; i >= 0; i--) {
    inputBuffer[prefix.length + i] = Number((nonceBig >> BigInt((31 - i) * 8)) & 0xFFn);
  }

  // Compute Ethereum keccak256
  const hash = keccak256(inputBuffer);

  // Convert hash hex to BigInt for comparison
  const hashBigInt = BigInt(hash);

  tried++;

  // Check if hash meets difficulty target
  if (hashBigInt < target) {
    parentPort?.postMessage({
      found: true,
      nonce,
      hash,
      textIndex,
      tried,
    });
    found = true;
    break;
  }

  // Periodic progress report
  if (tried % REPORT_INTERVAL === 0) {
    const elapsed = (Date.now() - startTime) / 1000;
    const hashRate = elapsed > 0 ? Math.round(tried / elapsed) : 0;
    parentPort?.postMessage({
      found: false,
      tried: REPORT_INTERVAL,
      textIndex,
      hashRate,
      lastHash: hash,
    });
  }
}

// Final report if not found
if (!found) {
  const elapsed = (Date.now() - startTime) / 1000;
  const remaining = tried % REPORT_INTERVAL || tried;
  const hashRate = elapsed > 0 ? Math.round(tried / elapsed) : 0;
  parentPort?.postMessage({
    found: false,
    tried: remaining,
    textIndex,
    hashRate,
    done: true,
  });
}
