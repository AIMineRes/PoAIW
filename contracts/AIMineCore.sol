// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AIMineToken.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AIMineCore
 * @dev Core mining contract implementing Proof of AI Work (PoAIW).
 *
 *      Mining mechanism:
 *      1. Contract publishes a challenge with a seed and difficulty target.
 *      2. Miners use AI to generate candidate text solutions (100-1000 bytes).
 *      3. Miners find a nonce such that:
 *         keccak256(currentSeed, challengeNumber, minerAddr, keccak256(solution), nonce) < target
 *      4. First valid submission wins the block reward.
 *      5. Each submission requires a protocol fee of 0.001 BNB.
 *
 *      Difficulty adjusts every 2016 challenges to maintain ~30s solve time.
 *      Block reward halves every 210,000 challenges (mirroring BTC).
 *      The contract can be paused by the owner in case of emergency.
 */
contract AIMineCore is Ownable, Pausable, ReentrancyGuard {
    // ======================== State ========================

    /// @notice Reference to the AIT token contract
    AIMineToken public immutable token;

    /// @notice Protocol fee recipient address
    address public immutable feeRecipient;

    /// @notice Current challenge number (starts at 1)
    uint256 public challengeNumber;

    /// @notice Seed for the current challenge (included in hash verification)
    bytes32 public currentSeed;

    /// @notice Current mining difficulty (higher = harder)
    uint256 public difficulty;

    /// @notice Timestamp when the current difficulty epoch started
    uint256 public epochStartTimestamp;

    /// @notice Timestamp of the last solved challenge
    uint256 public lastSolveTimestamp;

    // ======================== Constants ========================

    /// @notice Protocol fee per solution submission: 0.001 BNB
    uint256 public constant PROTOCOL_FEE = 0.001 ether;

    /// @notice Initial block reward: 50 AIT
    uint256 public constant INITIAL_REWARD = 50 * 10 ** 18;

    /// @notice Reward halves every 210,000 challenges
    uint256 public constant HALVING_INTERVAL = 210_000;

    /// @notice Difficulty adjusts every 2016 challenges
    uint256 public constant ADJUSTMENT_INTERVAL = 2016;

    /// @notice Target time per challenge in seconds
    uint256 public constant TARGET_SOLVE_TIME = 30;

    /// @notice Minimum solution length in bytes
    uint256 public constant MIN_SOLUTION_LENGTH = 100;

    /// @notice Maximum solution length in bytes
    uint256 public constant MAX_SOLUTION_LENGTH = 1000;

    /// @notice Minimum difficulty value
    uint256 public constant MIN_DIFFICULTY = 1;

    /// @notice Maximum difficulty value (prevents overflow in adjustment math)
    uint256 public constant MAX_DIFFICULTY = 2 ** 128;

    /// @notice Maximum difficulty adjustment factor (4x up or down)
    uint256 public constant MAX_ADJUSTMENT_FACTOR = 4;

    // ======================== Statistics ========================

    /// @notice Total number of solutions submitted across all challenges
    uint256 public totalSolutions;

    /// @notice Total protocol fees collected (in wei)
    uint256 public totalFeesCollected;

    /// @notice Number of solutions submitted by each miner
    mapping(address => uint256) public minerSolutions;

    /// @notice Total rewards earned by each miner (in wei)
    mapping(address => uint256) public minerRewards;

    /// @notice Winner of each challenge (challengeNumber => miner address)
    mapping(uint256 => address) public challengeWinner;

    // ======================== Events ========================

    /// @notice Emitted when a new challenge is generated
    event ChallengeNew(
        uint256 indexed challengeNumber,
        bytes32 seed,
        uint256 difficulty
    );

    /// @notice Emitted when a miner submits a valid solution
    event SolutionFound(
        address indexed miner,
        uint256 indexed challengeNumber,
        uint256 reward,
        bytes32 solutionHash
    );

    /// @notice Emitted when mining difficulty is adjusted
    event DifficultyAdjusted(uint256 oldDifficulty, uint256 newDifficulty);

    /// @notice Emitted when protocol fees are withdrawn
    event FeesWithdrawn(address indexed recipient, uint256 amount);

    // ======================== Constructor ========================

    /**
     * @notice Deploy the mining contract
     * @param _token Address of the AIMineToken contract
     * @param _initialDifficulty Starting difficulty level
     * @param _feeRecipient Address to receive protocol fees
     */
    constructor(
        address _token,
        uint256 _initialDifficulty,
        address _feeRecipient
    ) Ownable(msg.sender) {
        require(_token != address(0), "Invalid token address");
        require(_feeRecipient != address(0), "Invalid fee recipient");
        require(_initialDifficulty >= MIN_DIFFICULTY, "Difficulty too low");
        require(_initialDifficulty <= MAX_DIFFICULTY, "Difficulty too high");

        token = AIMineToken(_token);
        feeRecipient = _feeRecipient;
        difficulty = _initialDifficulty;
        challengeNumber = 1;
        currentSeed = _generateSeed(1);
        lastSolveTimestamp = block.timestamp;
        epochStartTimestamp = block.timestamp;

        emit ChallengeNew(challengeNumber, currentSeed, difficulty);
    }

    // ======================== Public View Functions ========================

    /**
     * @notice Get full details of the current challenge
     */
    function getCurrentChallenge()
        external
        view
        returns (
            uint256 _challengeNumber,
            bytes32 _seed,
            uint256 _difficulty,
            uint256 _difficultyTarget,
            uint256 _reward
        )
    {
        return (
            challengeNumber,
            currentSeed,
            difficulty,
            getDifficultyTarget(),
            getReward()
        );
    }

    /**
     * @notice Calculate the difficulty target from difficulty value
     */
    function getDifficultyTarget() public view returns (uint256) {
        return type(uint256).max / difficulty;
    }

    /**
     * @notice Calculate current block reward (includes halving)
     */
    function getReward() public view returns (uint256) {
        uint256 halvings = (challengeNumber - 1) / HALVING_INTERVAL;
        if (halvings >= 64) return 0;
        return INITIAL_REWARD >> halvings;
    }

    /**
     * @notice Get mining statistics for a specific miner
     */
    function getMinerStats(
        address miner
    ) external view returns (uint256 solutions, uint256 rewards) {
        return (minerSolutions[miner], minerRewards[miner]);
    }

    // ======================== Mining ========================

    /**
     * @notice Submit a mining solution
     * @dev Requires PROTOCOL_FEE (0.001 BNB). Excess is refunded.
     *      Hash includes currentSeed to prevent precomputation of future solutions.
     * @param solution AI-generated text (100-1000 bytes)
     * @param nonce Nonce value found through computation
     */
    function submitSolution(
        bytes calldata solution,
        uint256 nonce
    ) external payable whenNotPaused nonReentrant {
        // --- Validate protocol fee ---
        require(msg.value >= PROTOCOL_FEE, "Insufficient protocol fee");

        // --- Validate solution constraints ---
        require(
            solution.length >= MIN_SOLUTION_LENGTH,
            "Solution too short"
        );
        require(
            solution.length <= MAX_SOLUTION_LENGTH,
            "Solution too long"
        );

        // --- Ensure challenge is still open ---
        require(
            challengeWinner[challengeNumber] == address(0),
            "Challenge already solved"
        );

        // --- Verify proof of work (seed included to prevent precomputation) ---
        bytes32 solutionHash = keccak256(solution);
        bytes32 digest = keccak256(
            abi.encodePacked(
                currentSeed,
                challengeNumber,
                msg.sender,
                solutionHash,
                nonce
            )
        );
        require(
            uint256(digest) < getDifficultyTarget(),
            "Hash does not meet difficulty target"
        );

        // --- Collect protocol fee (only PROTOCOL_FEE, not full msg.value) ---
        totalFeesCollected += PROTOCOL_FEE;

        // --- Record solution ---
        challengeWinner[challengeNumber] = msg.sender;
        totalSolutions++;
        minerSolutions[msg.sender]++;

        // --- Distribute reward ---
        uint256 reward = getReward();
        if (reward > 0) {
            minerRewards[msg.sender] += reward;
            token.mint(msg.sender, reward);
        }

        emit SolutionFound(msg.sender, challengeNumber, reward, solutionHash);

        // --- Adjust difficulty at epoch boundary ---
        if (challengeNumber % ADJUSTMENT_INTERVAL == 0) {
            _adjustDifficulty();
        }

        // --- Advance to next challenge ---
        lastSolveTimestamp = block.timestamp;
        challengeNumber++;
        currentSeed = _generateSeed(challengeNumber);

        emit ChallengeNew(challengeNumber, currentSeed, difficulty);

        // --- Refund excess BNB if any ---
        if (msg.value > PROTOCOL_FEE) {
            (bool ok, ) = msg.sender.call{value: msg.value - PROTOCOL_FEE}(
                ""
            );
            require(ok, "Refund failed");
        }
    }

    // ======================== Emergency Controls ========================

    /**
     * @notice Pause mining submissions (emergency only)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Resume mining submissions
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Emergency difficulty reset (if mining gets stuck)
     * @param _newDifficulty New difficulty value
     */
    function emergencySetDifficulty(
        uint256 _newDifficulty
    ) external onlyOwner {
        require(_newDifficulty >= MIN_DIFFICULTY, "Difficulty too low");
        require(_newDifficulty <= MAX_DIFFICULTY, "Difficulty too high");
        uint256 oldDifficulty = difficulty;
        difficulty = _newDifficulty;
        epochStartTimestamp = block.timestamp;
        emit DifficultyAdjusted(oldDifficulty, _newDifficulty);
    }

    // ======================== Fee Management ========================

    /**
     * @notice Withdraw accumulated protocol fees to the fee recipient
     * @dev Only callable by owner or feeRecipient for operational control
     */
    function withdrawFees() external {
        require(
            msg.sender == owner() || msg.sender == feeRecipient,
            "Not authorized"
        );
        uint256 balance = address(this).balance;
        require(balance > 0, "No fees to withdraw");

        (bool success, ) = feeRecipient.call{value: balance}("");
        require(success, "Fee withdrawal failed");

        emit FeesWithdrawn(feeRecipient, balance);
    }

    // ======================== Internal Functions ========================

    /**
     * @dev Adjust mining difficulty based on actual vs expected solve rate.
     */
    function _adjustDifficulty() internal {
        uint256 timeElapsed = block.timestamp - epochStartTimestamp;
        uint256 expectedTime = ADJUSTMENT_INTERVAL * TARGET_SOLVE_TIME;

        uint256 oldDifficulty = difficulty;
        uint256 newDifficulty;

        if (timeElapsed == 0) {
            newDifficulty = difficulty * MAX_ADJUSTMENT_FACTOR;
        } else if (timeElapsed < expectedTime / MAX_ADJUSTMENT_FACTOR) {
            newDifficulty = difficulty * MAX_ADJUSTMENT_FACTOR;
        } else if (timeElapsed > expectedTime * MAX_ADJUSTMENT_FACTOR) {
            newDifficulty = difficulty / MAX_ADJUSTMENT_FACTOR;
            if (newDifficulty < MIN_DIFFICULTY) newDifficulty = MIN_DIFFICULTY;
        } else {
            newDifficulty = (difficulty * expectedTime) / timeElapsed;
            if (newDifficulty < MIN_DIFFICULTY) newDifficulty = MIN_DIFFICULTY;
        }

        // Cap difficulty to prevent overflow
        if (newDifficulty > MAX_DIFFICULTY) newDifficulty = MAX_DIFFICULTY;

        difficulty = newDifficulty;
        epochStartTimestamp = block.timestamp;

        emit DifficultyAdjusted(oldDifficulty, newDifficulty);
    }

    /**
     * @dev Generate a pseudo-random seed for a challenge.
     */
    function _generateSeed(
        uint256 _challengeNumber
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    blockhash(block.number - 1),
                    _challengeNumber,
                    block.timestamp
                )
            );
    }
}
