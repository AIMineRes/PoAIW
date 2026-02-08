import { ethers } from "ethers";
import { AIMINE_CORE_ABI, AIMINE_TOKEN_ABI } from "./abi";
import { MinerConfig } from "./config";

/** Protocol fee: 0.001 BNB per solution submission */
export const PROTOCOL_FEE = ethers.parseEther("0.001");

/**
 * Challenge data from the smart contract
 */
export interface Challenge {
  challengeNumber: bigint;
  seed: string;
  difficulty: bigint;
  difficultyTarget: bigint;
  reward: bigint;
}

/**
 * Miner statistics from the smart contract
 */
export interface MinerStats {
  solutions: bigint;
  rewards: bigint;
}

/**
 * Blockchain interaction layer.
 * Handles all communication with the BNB Chain smart contracts.
 */
export class ChainClient {
  public provider: ethers.JsonRpcProvider;
  public wallet: ethers.Wallet;
  public coreContract: ethers.Contract;
  public tokenContract: ethers.Contract;
  public address: string;

  constructor(config: MinerConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.address = this.wallet.address;

    this.coreContract = new ethers.Contract(
      config.coreContract,
      AIMINE_CORE_ABI,
      this.wallet
    );

    this.tokenContract = new ethers.Contract(
      config.tokenContract,
      AIMINE_TOKEN_ABI,
      this.provider
    );
  }

  /**
   * Fetch current challenge from the mining contract
   */
  async getCurrentChallenge(): Promise<Challenge> {
    const result = await this.coreContract.getCurrentChallenge();
    return {
      challengeNumber: result._challengeNumber,
      seed: result._seed,
      difficulty: result._difficulty,
      difficultyTarget: result._difficultyTarget,
      reward: result._reward,
    };
  }

  /**
   * Check if the current challenge is still open (not yet solved).
   * Used as a pre-submit check to avoid wasting gas.
   */
  async isChallengeOpen(challengeNumber: bigint): Promise<boolean> {
    const winner = await this.coreContract.challengeWinner(challengeNumber);
    return winner === ethers.ZeroAddress;
  }

  /**
   * Check if the mining contract is paused.
   */
  async isPaused(): Promise<boolean> {
    return await this.coreContract.paused();
  }

  /**
   * Submit a valid solution to the contract.
   * Sends PROTOCOL_FEE (0.001 BNB) along with the transaction.
   * Uses dynamic gas pricing for competitive submission.
   */
  async submitSolution(
    solution: Uint8Array,
    nonce: bigint,
    gasLimit: number
  ): Promise<ethers.TransactionReceipt | null> {
    // Get current gas price and add 10% premium for faster inclusion
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice
      ? (feeData.gasPrice * 110n) / 100n
      : undefined;

    const tx = await this.coreContract.submitSolution(solution, nonce, {
      value: PROTOCOL_FEE,
      gasLimit,
      gasPrice,
    });
    return await tx.wait();
  }

  /**
   * Get AIT token balance of the miner
   */
  async getTokenBalance(): Promise<bigint> {
    return await this.tokenContract.balanceOf(this.address);
  }

  /**
   * Get BNB balance of the miner wallet
   */
  async getBnbBalance(): Promise<bigint> {
    return await this.provider.getBalance(this.address);
  }

  /**
   * Get miner statistics (solutions found, total rewards)
   */
  async getMinerStats(): Promise<MinerStats> {
    const result = await this.coreContract.getMinerStats(this.address);
    return {
      solutions: result.solutions,
      rewards: result.rewards,
    };
  }

  /**
   * Get total solutions found across all miners
   */
  async getTotalSolutions(): Promise<bigint> {
    return await this.coreContract.totalSolutions();
  }

  /**
   * Get total AIT token supply (all minted so far)
   */
  async getTokenTotalSupply(): Promise<bigint> {
    return await this.tokenContract.totalSupply();
  }

  /**
   * Listen for new challenge events
   */
  onNewChallenge(
    callback: (challengeNumber: bigint, seed: string, difficulty: bigint) => void
  ): void {
    this.coreContract.on("ChallengeNew", callback);
  }

  /**
   * Listen for solution found events (from any miner)
   */
  onSolutionFound(
    callback: (miner: string, challengeNumber: bigint, reward: bigint, solutionHash: string) => void
  ): void {
    this.coreContract.on("SolutionFound", callback);
  }

  /**
   * Clean up event listeners
   */
  removeAllListeners(): void {
    this.coreContract.removeAllListeners();
  }
}
