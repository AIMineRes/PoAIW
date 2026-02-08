import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const PROTOCOL_FEE = ethers.parseEther("0.001");

describe("AI Mining", function () {
  // ==================== Fixtures ====================

  async function deployFixture() {
    const [owner, miner1, miner2, feeRecipient] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("AIMineToken");
    const token = await Token.deploy();

    const Core = await ethers.getContractFactory("AIMineCore");
    const core = await Core.deploy(
      await token.getAddress(),
      1,
      feeRecipient.address
    );

    await token.setMiningContract(await core.getAddress());

    return { token, core, owner, miner1, miner2, feeRecipient };
  }

  // Helper: find valid solution (includes seed in hash)
  async function findSolution(core: any, miner: any) {
    const challenge = await core.getCurrentChallenge();
    const challengeNumber = challenge._challengeNumber;
    const seed = challenge._seed;
    const difficultyTarget = challenge._difficultyTarget;

    const solution = "A".repeat(200);
    const solutionBytes = ethers.toUtf8Bytes(solution);
    const solutionHash = ethers.keccak256(solutionBytes);

    // Hash now includes seed: keccak256(seed, challengeNumber, miner, solutionHash, nonce)
    for (let nonce = 0; nonce < 1_000_000; nonce++) {
      const digest = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "uint256", "address", "bytes32", "uint256"],
          [seed, challengeNumber, miner.address, solutionHash, nonce]
        )
      );
      if (BigInt(digest) < BigInt(difficultyTarget)) {
        return { solution: solutionBytes, nonce };
      }
    }
    throw new Error("Could not find valid nonce within range");
  }

  // Helper: submit with fee
  function submit(core: any, miner: any, solution: any, nonce: number) {
    return core
      .connect(miner)
      .submitSolution(solution, nonce, { value: PROTOCOL_FEE });
  }

  // ==================== Token Tests ====================

  describe("AIMineToken", function () {
    it("should deploy with correct name and symbol", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("AI Mine Token");
      expect(await token.symbol()).to.equal("AIT");
    });

    it("should have zero initial supply", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.totalSupply()).to.equal(0);
    });

    it("should have correct MAX_SUPPLY", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.MAX_SUPPLY()).to.equal(ethers.parseEther("21000000"));
    });

    it("should only allow owner to set mining contract", async function () {
      const { token, miner1 } = await loadFixture(deployFixture);
      await expect(
        token.connect(miner1).setMiningContract(miner1.address)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("should reject zero address for mining contract", async function () {
      const { token } = await loadFixture(deployFixture);
      await expect(
        token.setMiningContract(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid mining contract address");
    });

    it("should only allow mining contract to mint", async function () {
      const { token, miner1 } = await loadFixture(deployFixture);
      await expect(
        token.connect(miner1).mint(miner1.address, 100)
      ).to.be.revertedWith("Only mining contract can mint");
    });
  });

  // ==================== Mining Core Tests ====================

  describe("AIMineCore", function () {
    it("should initialize with correct state", async function () {
      const { core } = await loadFixture(deployFixture);
      expect(await core.challengeNumber()).to.equal(1);
      expect(await core.difficulty()).to.equal(1);
      expect(await core.totalSolutions()).to.equal(0);
      expect(await core.PROTOCOL_FEE()).to.equal(PROTOCOL_FEE);
    });

    it("should return current challenge details", async function () {
      const { core } = await loadFixture(deployFixture);
      const challenge = await core.getCurrentChallenge();
      expect(challenge._challengeNumber).to.equal(1);
      expect(challenge._difficulty).to.equal(1);
      expect(challenge._reward).to.equal(ethers.parseEther("50"));
      // Seed should be non-zero
      expect(challenge._seed).to.not.equal(ethers.ZeroHash);
    });

    it("should reject submission without protocol fee", async function () {
      const { core, miner1 } = await loadFixture(deployFixture);
      const { solution, nonce } = await findSolution(core, miner1);
      await expect(
        core.connect(miner1).submitSolution(solution, nonce, { value: 0 })
      ).to.be.revertedWith("Insufficient protocol fee");
    });

    it("should reject insufficient protocol fee", async function () {
      const { core, miner1 } = await loadFixture(deployFixture);
      const { solution, nonce } = await findSolution(core, miner1);
      await expect(
        core.connect(miner1).submitSolution(solution, nonce, {
          value: ethers.parseEther("0.0005"),
        })
      ).to.be.revertedWith("Insufficient protocol fee");
    });

    it("should reject solution that is too short", async function () {
      const { core, miner1 } = await loadFixture(deployFixture);
      const shortSolution = ethers.toUtf8Bytes("too short");
      await expect(
        core.connect(miner1).submitSolution(shortSolution, 0, {
          value: PROTOCOL_FEE,
        })
      ).to.be.revertedWith("Solution too short");
    });

    it("should reject solution that is too long", async function () {
      const { core, miner1 } = await loadFixture(deployFixture);
      const longSolution = ethers.toUtf8Bytes("X".repeat(1001));
      await expect(
        core.connect(miner1).submitSolution(longSolution, 0, {
          value: PROTOCOL_FEE,
        })
      ).to.be.revertedWith("Solution too long");
    });

    it("should accept valid solution with fee and mint reward", async function () {
      const { core, token, miner1 } = await loadFixture(deployFixture);
      const { solution, nonce } = await findSolution(core, miner1);

      await expect(submit(core, miner1, solution, nonce))
        .to.emit(core, "SolutionFound")
        .to.emit(core, "ChallengeNew");

      expect(await token.balanceOf(miner1.address)).to.equal(
        ethers.parseEther("50")
      );
      // Fee accounting: only PROTOCOL_FEE, not full msg.value
      expect(await core.totalFeesCollected()).to.equal(PROTOCOL_FEE);
      expect(await core.totalSolutions()).to.equal(1);
      expect(await core.challengeNumber()).to.equal(2);
    });

    it("should advance challenge number after each solution", async function () {
      const { core, miner1 } = await loadFixture(deployFixture);

      const sol1 = await findSolution(core, miner1);
      await submit(core, miner1, sol1.solution, sol1.nonce);
      expect(await core.challengeNumber()).to.equal(2);

      const sol2 = await findSolution(core, miner1);
      await submit(core, miner1, sol2.solution, sol2.nonce);
      expect(await core.challengeNumber()).to.equal(3);
    });

    it("should track totalFeesCollected correctly with excess BNB", async function () {
      const { core, miner1 } = await loadFixture(deployFixture);
      const { solution, nonce } = await findSolution(core, miner1);

      // Send 10x the fee
      await core.connect(miner1).submitSolution(solution, nonce, {
        value: ethers.parseEther("0.01"),
      });

      // totalFeesCollected should only count PROTOCOL_FEE, not the excess
      expect(await core.totalFeesCollected()).to.equal(PROTOCOL_FEE);
    });

    it("should refund excess BNB", async function () {
      const { core, miner1 } = await loadFixture(deployFixture);
      const { solution, nonce } = await findSolution(core, miner1);

      const excess = ethers.parseEther("0.01");
      const balBefore = await ethers.provider.getBalance(miner1.address);

      const tx = await core
        .connect(miner1)
        .submitSolution(solution, nonce, { value: excess });
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      const balAfter = await ethers.provider.getBalance(miner1.address);
      const actualCost = balBefore - balAfter - gasCost;
      expect(actualCost).to.equal(PROTOCOL_FEE);
    });

    it("should allow fee withdrawal by owner", async function () {
      const { core, owner, miner1, feeRecipient } = await loadFixture(
        deployFixture
      );

      const { solution, nonce } = await findSolution(core, miner1);
      await submit(core, miner1, solution, nonce);

      const balBefore = await ethers.provider.getBalance(feeRecipient.address);
      await core.connect(owner).withdrawFees();
      const balAfter = await ethers.provider.getBalance(feeRecipient.address);

      expect(balAfter - balBefore).to.equal(PROTOCOL_FEE);
    });

    it("should reject fee withdrawal by unauthorized address", async function () {
      const { core, miner1 } = await loadFixture(deployFixture);

      const { solution, nonce } = await findSolution(core, miner1);
      await submit(core, miner1, solution, nonce);

      await expect(
        core.connect(miner1).withdrawFees()
      ).to.be.revertedWith("Not authorized");
    });

    it("should reject withdrawal when no fees", async function () {
      const { core } = await loadFixture(deployFixture);
      await expect(core.withdrawFees()).to.be.revertedWith(
        "No fees to withdraw"
      );
    });

    it("should allow owner to pause and unpause", async function () {
      const { core, owner, miner1 } = await loadFixture(deployFixture);

      await core.connect(owner).pause();
      expect(await core.paused()).to.equal(true);

      const { solution, nonce } = await findSolution(core, miner1);
      await expect(
        submit(core, miner1, solution, nonce)
      ).to.be.revertedWithCustomError(core, "EnforcedPause");

      await core.connect(owner).unpause();
      expect(await core.paused()).to.equal(false);

      // Should work after unpause
      await expect(submit(core, miner1, solution, nonce)).to.not.be.reverted;
    });

    it("should allow emergency difficulty reset", async function () {
      const { core, owner } = await loadFixture(deployFixture);

      await expect(core.connect(owner).emergencySetDifficulty(1000))
        .to.emit(core, "DifficultyAdjusted")
        .withArgs(1, 1000);

      expect(await core.difficulty()).to.equal(1000);
    });

    it("should reject difficulty above MAX_DIFFICULTY", async function () {
      const { core, owner } = await loadFixture(deployFixture);
      await expect(
        core.connect(owner).emergencySetDifficulty(BigInt(2) ** BigInt(129))
      ).to.be.revertedWith("Difficulty too high");
    });

    it("should allow multiple miners to compete", async function () {
      const { core, token, miner1, miner2 } = await loadFixture(
        deployFixture
      );

      const sol1 = await findSolution(core, miner1);
      await submit(core, miner1, sol1.solution, sol1.nonce);

      const sol2 = await findSolution(core, miner2);
      await submit(core, miner2, sol2.solution, sol2.nonce);

      expect(await token.balanceOf(miner1.address)).to.equal(
        ethers.parseEther("50")
      );
      expect(await token.balanceOf(miner2.address)).to.equal(
        ethers.parseEther("50")
      );
      expect(await core.totalSolutions()).to.equal(2);
      expect(await core.totalFeesCollected()).to.equal(PROTOCOL_FEE * 2n);
    });

    it("should compute difficulty target correctly", async function () {
      const { core } = await loadFixture(deployFixture);
      const target = await core.getDifficultyTarget();
      const maxUint256 = BigInt(2) ** BigInt(256) - BigInt(1);
      expect(target).to.equal(maxUint256);
    });

    it("should reject invalid hash (wrong nonce)", async function () {
      const { core, miner1, feeRecipient } = await loadFixture(deployFixture);

      const Token = await ethers.getContractFactory("AIMineToken");
      const token2 = await Token.deploy();
      const Core = await ethers.getContractFactory("AIMineCore");
      const hardCore = await Core.deploy(
        await token2.getAddress(),
        BigInt(2) ** BigInt(128),
        feeRecipient.address
      );
      await token2.setMiningContract(await hardCore.getAddress());

      const solution = ethers.toUtf8Bytes("A".repeat(200));
      await expect(
        hardCore
          .connect(miner1)
          .submitSolution(solution, 999999, { value: PROTOCOL_FEE })
      ).to.be.revertedWith("Hash does not meet difficulty target");
    });
  });
});
