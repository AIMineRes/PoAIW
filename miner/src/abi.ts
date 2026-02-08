/**
 * ABI definitions for AI Mining smart contracts.
 * Extracted from compiled Solidity contracts.
 */

export const AIMINE_CORE_ABI = [
  // Read functions
  "function challengeNumber() view returns (uint256)",
  "function currentSeed() view returns (bytes32)",
  "function difficulty() view returns (uint256)",
  "function totalSolutions() view returns (uint256)",
  "function getCurrentChallenge() view returns (uint256 _challengeNumber, bytes32 _seed, uint256 _difficulty, uint256 _difficultyTarget, uint256 _reward)",
  "function getDifficultyTarget() view returns (uint256)",
  "function getReward() view returns (uint256)",
  "function getMinerStats(address miner) view returns (uint256 solutions, uint256 rewards)",
  "function challengeWinner(uint256) view returns (address)",
  "function minerSolutions(address) view returns (uint256)",
  "function minerRewards(address) view returns (uint256)",
  "function HALVING_INTERVAL() view returns (uint256)",
  "function ADJUSTMENT_INTERVAL() view returns (uint256)",
  "function PROTOCOL_FEE() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function totalFeesCollected() view returns (uint256)",
  "function paused() view returns (bool)",

  // Write functions
  "function submitSolution(bytes solution, uint256 nonce) payable",
  "function withdrawFees()",
  "function pause()",
  "function unpause()",
  "function emergencySetDifficulty(uint256 _newDifficulty)",

  // Events
  "event ChallengeNew(uint256 indexed challengeNumber, bytes32 seed, uint256 difficulty)",
  "event SolutionFound(address indexed miner, uint256 indexed challengeNumber, uint256 reward, bytes32 solutionHash)",
  "event DifficultyAdjusted(uint256 oldDifficulty, uint256 newDifficulty)",
  "event FeesWithdrawn(address indexed recipient, uint256 amount)",
];

export const AIMINE_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
