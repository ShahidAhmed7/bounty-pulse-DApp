// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BountyPulse} from "../src/BountyPulse.sol";

contract BountyPulseTest is Test {
    BountyPulse bountyPulse;

    function setUp() public {
        bountyPulse = new BountyPulse();
    }

    function testArbiterIsDeployer() public view {
        assertEq(bountyPulse.arbiter(), address(this));
    }
}