/**
 * Set mining difficulty (owner only). Use to lower difficulty if mining is too slow.
 * Run: npx hardhat run scripts/set-difficulty.ts --network bscMainnet
 * Or with explicit value: DIFFICULTY=1048576 npx hardhat run scripts/set-difficulty.ts --network bscMainnet
 *
 * Examples:
 *   DIFFICULTY=1048576  -> 2^20 (easier, ~1M hashes per solution)
 *   DIFFICULTY=2097152  -> 2^21
 *   Current on-chain difficulty is printed so you can halve it (e.g. divide by 2 or 4).
 */

import { ethers } from "hardhat";

const AIMINE_CORE_MAINNET = "0xA21eed5825Cce36457bc28dAf8F9bB5C993b9F36";

async function main() {
  const coreAddress = process.env.CONTRACT_AIMINE_CORE || AIMINE_CORE_MAINNET;
  const [signer] = await ethers.getSigners();
  console.log("Using account:", signer.address);

  const core = await ethers.getContractAt(
    "AIMineCore",
    coreAddress
  );

  const current = await core.difficulty();
  console.log("Current difficulty (on-chain):", current.toString());

  const raw = process.env.DIFFICULTY;
  let newDifficulty: bigint;
  if (raw) {
    newDifficulty = BigInt(raw);
  } else {
    newDifficulty = current / 2n;
    if (newDifficulty < 1n) newDifficulty = 1n;
    console.log("No DIFFICULTY env set; using half of current:", newDifficulty.toString());
  }

  const minD = await core.MIN_DIFFICULTY();
  const maxD = await core.MAX_DIFFICULTY();
  if (newDifficulty < minD || newDifficulty > maxD) {
    console.error("New difficulty must be between", minD.toString(), "and", maxD.toString());
    process.exit(1);
  }

  console.log("Calling emergencySetDifficulty(" + newDifficulty + ")...");
  const tx = await core.emergencySetDifficulty(newDifficulty);
  await tx.wait();
  console.log("Done. Tx:", tx.hash);
  const after = await core.difficulty();
  console.log("New difficulty (on-chain):", after.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
