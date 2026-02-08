// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AIMineToken
 * @dev BEP-20 token for the AI Mining ecosystem.
 *      Minting is restricted to the authorized mining contract.
 *      Maximum supply is capped at 21 million tokens (mirroring BTC).
 */
contract AIMineToken is ERC20, Ownable {
    /// @notice Maximum token supply: 21 million
    uint256 public constant MAX_SUPPLY = 21_000_000 * 10 ** 18;

    /// @notice Address of the mining contract authorized to mint tokens
    address public miningContract;

    /// @notice Emitted when the mining contract address is updated
    event MiningContractUpdated(
        address indexed oldContract,
        address indexed newContract
    );

    constructor() ERC20("AI Mine Token", "AIT") Ownable(msg.sender) {}

    /**
     * @notice Set the mining contract address authorized to mint tokens
     * @param _miningContract Address of the mining contract
     */
    function setMiningContract(address _miningContract) external onlyOwner {
        require(
            _miningContract != address(0),
            "Invalid mining contract address"
        );
        address oldContract = miningContract;
        miningContract = _miningContract;
        emit MiningContractUpdated(oldContract, _miningContract);
    }

    /**
     * @notice Mint new tokens. Only callable by the mining contract.
     * @param to Recipient address
     * @param amount Amount of tokens to mint (in wei)
     */
    function mint(address to, uint256 amount) external {
        require(msg.sender == miningContract, "Only mining contract can mint");
        require(totalSupply() + amount <= MAX_SUPPLY, "Exceeds maximum supply");
        _mint(to, amount);
    }
}
