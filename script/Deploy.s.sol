// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BountyPulse} from "../src/BountyPulse.sol";

/// @notice Deploys BountyPulse to whichever chain --rpc-url points at.
/// @dev The broadcasting account becomes the arbiter, so deploy with the account
///      you intend to demo as the admin.
///
/// Usage against a local Anvil node:
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url http://127.0.0.1:8545 \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
///     --broadcast -vvv
contract Deploy is Script {
    function run() external returns (BountyPulse bountyPulse) {
        vm.startBroadcast();
        bountyPulse = new BountyPulse();
        vm.stopBroadcast();

        console.log("-------------------------------------------------");
        console.log("BountyPulse deployed");
        console.log("  address :", address(bountyPulse));
        console.log("  arbiter :", bountyPulse.arbiter());
        console.log("  fee     :", bountyPulse.PLATFORM_FEE_PERCENT(), "percent");
        console.log("-------------------------------------------------");
        console.log("Copy the address above into the frontend config.");
    }
}
