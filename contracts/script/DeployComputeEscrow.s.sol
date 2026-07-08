// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Feature 6 (Escrowed Paid Compute) — deploys a SECOND instance of the
// unmodified ReuniteEscrow contract (see src/ReuniteEscrow.sol), configured
// with a short REFUND_TIMEOUT suited to compute jobs (seconds/minutes, not
// the 24h window Reunite bounties use). REFUND_TIMEOUT is immutable and set
// once per deployment, not per-alert, so a single contract instance cannot
// serve both use cases with the timeouts each actually needs.
//
// No Solidity changes. No new contract. Same bytecode as Deploy.s.sol
// deploys for Reunite, just a different constructor argument.
//
// Usage: forge script script/DeployComputeEscrow.s.sol --rpc-url sepolia --broadcast
// Then set COMPUTE_ESCROW=<printed address> in the app's environment. If left
// unset, lib/wallet.js falls back to the Reunite deployment automatically —
// compute jobs still work correctly (namespaced ids can't collide), just with
// a 24h refund window instead of a fast one.
import "forge-std/Script.sol";
import "../src/ReuniteEscrow.sol";

contract DeployComputeEscrow is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0));
        address usdtAddress = vm.envOr("USDT_ADDRESS", address(0xd077A400968890Eacc75cdc901F0356c943e4fDb));
        uint256 timeout = vm.envOr("COMPUTE_REFUND_TIMEOUT", uint256(5 minutes));

        vm.startBroadcast(deployerPrivateKey);

        ReuniteEscrow computeEscrow = new ReuniteEscrow(usdtAddress, timeout);
        console.log("Deployed compute-job ReuniteEscrow instance at:", address(computeEscrow));
        console.log("REFUND_TIMEOUT (seconds):", timeout);

        vm.stopBroadcast();
    }
}
