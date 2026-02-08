import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "BNB"
  );

  // --- Deploy AIMineToken ---
  console.log("\n[1/3] Deploying AIMineToken...");
  const Token = await ethers.getContractFactory("AIMineToken");
  const token = await Token.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log("AIMineToken deployed to:", tokenAddress);

  // --- Deploy AIMineCore ---
  // Initial difficulty: 2^20 (~1M hashes to find a solution)
  const initialDifficulty = BigInt(2) ** BigInt(20);
  // Fee recipient: deployer address
  const feeRecipient = deployer.address;
  console.log("\n[2/3] Deploying AIMineCore...");
  console.log("Initial difficulty:", initialDifficulty.toString());
  console.log("Fee recipient:", feeRecipient);
  console.log("Protocol fee: 0.001 BNB per solution");
  const Core = await ethers.getContractFactory("AIMineCore");
  const core = await Core.deploy(tokenAddress, initialDifficulty, feeRecipient);
  await core.waitForDeployment();
  const coreAddress = await core.getAddress();
  console.log("AIMineCore deployed to:", coreAddress);

  // --- Authorize mining contract to mint tokens ---
  console.log("\n[3/3] Authorizing mining contract to mint tokens...");
  const tx = await token.setMiningContract(coreAddress);
  await tx.wait();
  console.log("Mining contract authorized.");

  // --- Summary ---
  console.log("\n========================================");
  console.log("   Deployment Complete!");
  console.log("========================================");
  console.log("AIMineToken:  ", tokenAddress);
  console.log("AIMineCore:   ", coreAddress);
  console.log("Fee Recipient:", feeRecipient);
  console.log("Difficulty:   ", initialDifficulty.toString());
  console.log("Reward:        50 AIT per block");
  console.log("Protocol Fee:  0.001 BNB per solution");
  console.log("Max Supply:    21,000,000 AIT");
  console.log("========================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
