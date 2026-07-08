// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/ReuniteEscrow.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDT is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {
        _mint(msg.sender, 1000000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0));

        vm.startBroadcast(deployerPrivateKey);

        address usdtAddress;
        uint256 timeout = 24 hours; // default 24 hours timeout

        if (block.chainid == 11155111) {
            // Sepolia testnet
            usdtAddress = 0xd077A400968890Eacc75cdc901F0356c943e4fDb;
            console.log("Sepolia network detected.");
            console.log("Using existing Sepolia USDt at:", usdtAddress);
        } else {
            // Local Anvil or other network
            console.log("Local or alternative network detected. Chain ID:", block.chainid);
            MockUSDT mockUsdt = new MockUSDT();
            usdtAddress = address(mockUsdt);
            console.log("Deployed MockUSDT at:", usdtAddress);
        }

        ReuniteEscrow escrow = new ReuniteEscrow(usdtAddress, timeout);
        console.log("Deployed ReuniteEscrow at:", address(escrow));

        vm.stopBroadcast();
    }
}
