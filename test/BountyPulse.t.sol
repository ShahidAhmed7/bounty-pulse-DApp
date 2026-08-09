// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BountyPulse} from "../src/BountyPulse.sol";

contract BountyPulseTest is Test {
    BountyPulse bountyPulse;

    address client = makeAddr("client");
    address freelancer = makeAddr("freelancer");

    function setUp() public {
        bountyPulse = new BountyPulse();
    }

    /// This test contract deploys the contract, so it *is* the arbiter and must be
    /// able to receive ETH when claiming platform fees.
    receive() external payable {}

    function testArbiterIsDeployer() public view {
        assertEq(bountyPulse.arbiter(), address(this));
    }

    function testFreelancerStartsAt100Reputation() public {
        vm.prank(freelancer);
        bountyPulse.register("Freya", "QmAvatar", BountyPulse.Role.Freelancer);

        assertEq(bountyPulse.getUser(freelancer).reputation, 100);
    }

    function testCannotRegisterTwice() public {
        vm.startPrank(client);
        bountyPulse.register("Clara", "QmAvatar", BountyPulse.Role.Client);

        vm.expectRevert("Already registered");
        bountyPulse.register("Clara Again", "QmAvatar", BountyPulse.Role.Client);
        vm.stopPrank();
    }

    function testCannotSelfAssignArbiterRole() public {
        vm.prank(client);
        vm.expectRevert("Pick Client or Freelancer");
        bountyPulse.register("Sneaky", "QmAvatar", BountyPulse.Role.Arbiter);
    }

    // -----------------------------------------------------------------
    // Section 2: bounties and bids
    // -----------------------------------------------------------------

    /// Registers both actors so bounty tests start from a known state.
    function _registerBoth() internal {
        vm.prank(client);
        bountyPulse.register("Clara", "QmAvatar", BountyPulse.Role.Client);
        vm.prank(freelancer);
        bountyPulse.register("Freya", "QmAvatar", BountyPulse.Role.Freelancer);
    }

    function testPostBountyStartsOpen() public {
        _registerBoth();

        vm.prank(client);
        uint256 id = bountyPulse.postBounty(1 ether, "QmDetails");

        BountyPulse.Bounty memory b = bountyPulse.getBounty(id);
        assertEq(id, 0);
        assertEq(b.client, client);
        assertEq(b.maxBudget, 1 ether);
        assertEq(b.escrow, 0);
        assertEq(uint256(b.status), uint256(BountyPulse.Status.Open));
    }

    function testFreelancerCannotPostBounty() public {
        _registerBoth();

        vm.prank(freelancer);
        vm.expectRevert("Wrong role");
        bountyPulse.postBounty(1 ether, "QmDetails");
    }

    function testBidCannotExceedMaxBudget() public {
        _registerBoth();
        vm.prank(client);
        uint256 id = bountyPulse.postBounty(1 ether, "QmDetails");

        vm.prank(freelancer);
        vm.expectRevert("Bid exceeds budget");
        bountyPulse.placeBid(id, 1 ether + 1);
    }

    function testBidAtExactBudgetIsAllowed() public {
        _registerBoth();
        vm.prank(client);
        uint256 id = bountyPulse.postBounty(1 ether, "QmDetails");

        vm.prank(freelancer);
        bountyPulse.placeBid(id, 1 ether);

        BountyPulse.Bid[] memory placed = bountyPulse.getBids(id);
        assertEq(placed.length, 1);
        assertEq(placed[0].freelancer, freelancer);
        assertEq(placed[0].amount, 1 ether);
    }

    function testCannotBidTwiceOnSameBounty() public {
        _registerBoth();
        vm.prank(client);
        uint256 id = bountyPulse.postBounty(1 ether, "QmDetails");

        vm.startPrank(freelancer);
        bountyPulse.placeBid(id, 0.5 ether);
        vm.expectRevert("Already bid");
        bountyPulse.placeBid(id, 0.4 ether);
        vm.stopPrank();
    }

    function testCannotBidOnNonexistentBounty() public {
        _registerBoth();

        vm.prank(freelancer);
        vm.expectRevert("No such bounty");
        bountyPulse.placeBid(99, 1 ether);
    }

    // -----------------------------------------------------------------
    // Section 3: escrow funding and the exact-payment rule
    // -----------------------------------------------------------------

    /// Registers both actors, posts a 1 ETH bounty, and places a 0.8 ETH bid on it.
    function _bountyWithBid() internal returns (uint256 id) {
        _registerBoth();
        vm.prank(client);
        id = bountyPulse.postBounty(1 ether, "QmDetails");
        vm.prank(freelancer);
        bountyPulse.placeBid(id, 0.8 ether);
    }

    function testExactPaymentLocksEscrow() public {
        uint256 id = _bountyWithBid();

        vm.deal(client, 1 ether);
        vm.prank(client);
        bountyPulse.fundEscrow{value: 0.8 ether}(id, 0);

        BountyPulse.Bounty memory b = bountyPulse.getBounty(id);
        assertEq(uint256(b.status), uint256(BountyPulse.Status.Locked));
        assertEq(b.winner, freelancer);
        assertEq(b.escrow, 0.8 ether);
        assertEq(address(bountyPulse).balance, 0.8 ether);
    }

    function testUnderpaymentRevertsEntireTransaction() public {
        uint256 id = _bountyWithBid();

        vm.deal(client, 1 ether);
        vm.prank(client);
        vm.expectRevert("Send exact bid amount");
        bountyPulse.fundEscrow{value: 0.79 ether}(id, 0);

        // Nothing moved and the bounty is untouched.
        BountyPulse.Bounty memory b = bountyPulse.getBounty(id);
        assertEq(uint256(b.status), uint256(BountyPulse.Status.Open));
        assertEq(address(bountyPulse).balance, 0);
        assertEq(client.balance, 1 ether);
    }

    function testOverpaymentRefundsExcessSameTransaction() public {
        uint256 id = _bountyWithBid();

        vm.deal(client, 2 ether);
        vm.prank(client);
        bountyPulse.fundEscrow{value: 1 ether}(id, 0);

        // Contract keeps exactly the bid; the 0.2 ETH surplus went straight back.
        assertEq(address(bountyPulse).balance, 0.8 ether);
        assertEq(client.balance, 1.2 ether);
        assertEq(bountyPulse.getBounty(id).escrow, 0.8 ether);
    }

    function testCannotFundSomeoneElsesBounty() public {
        uint256 id = _bountyWithBid();
        address otherClient = makeAddr("otherClient");

        vm.prank(otherClient);
        bountyPulse.register("Otto", "QmAvatar", BountyPulse.Role.Client);

        vm.deal(otherClient, 1 ether);
        vm.prank(otherClient);
        vm.expectRevert("Not your bounty");
        bountyPulse.fundEscrow{value: 0.8 ether}(id, 0);
    }

    function testCannotFundTwice() public {
        uint256 id = _bountyWithBid();

        vm.deal(client, 2 ether);
        vm.startPrank(client);
        bountyPulse.fundEscrow{value: 0.8 ether}(id, 0);

        vm.expectRevert("Bounty not open");
        bountyPulse.fundEscrow{value: 0.8 ether}(id, 0);
        vm.stopPrank();
    }

    function testCannotFundNonexistentBid() public {
        uint256 id = _bountyWithBid();

        vm.deal(client, 1 ether);
        vm.prank(client);
        vm.expectRevert("No such bid");
        bountyPulse.fundEscrow{value: 0.8 ether}(id, 5);
    }

    // -----------------------------------------------------------------
    // Sections 4 and 5: approval, fees, pull payment, disputes
    // -----------------------------------------------------------------

    /// Full happy path up to the point where work is awaiting client approval.
    function _submittedWork() internal returns (uint256 id) {
        id = _bountyWithBid();
        vm.deal(client, 1 ether);
        vm.prank(client);
        bountyPulse.fundEscrow{value: 0.8 ether}(id, 0);
        vm.prank(freelancer);
        bountyPulse.submitWork(id, "QmWorkFile");
    }

    function testApprovalSplitsFeeAndCreditsBalances() public {
        uint256 id = _submittedWork();

        vm.prank(client);
        bountyPulse.approveWork(id);

        // 2% of 0.8 ETH = 0.016 ETH fee, 0.784 ETH to the freelancer.
        assertEq(bountyPulse.withdrawable(address(this)), 0.016 ether);
        assertEq(bountyPulse.withdrawable(freelancer), 0.784 ether);
        assertEq(bountyPulse.withdrawable(address(this)) + bountyPulse.withdrawable(freelancer), 0.8 ether);

        // Pull payment: the ETH has NOT moved yet.
        assertEq(address(bountyPulse).balance, 0.8 ether);
        assertEq(freelancer.balance, 0);

        BountyPulse.Bounty memory b = bountyPulse.getBounty(id);
        assertEq(uint256(b.status), uint256(BountyPulse.Status.Resolved));
        assertEq(b.escrow, 0);
        assertEq(bountyPulse.getUser(freelancer).reputation, 115);
    }

    function testClaimFundsMovesEthAndZeroesLedger() public {
        uint256 id = _submittedWork();
        vm.prank(client);
        bountyPulse.approveWork(id);

        vm.prank(freelancer);
        bountyPulse.claimFunds();

        assertEq(freelancer.balance, 0.784 ether);
        assertEq(bountyPulse.withdrawable(freelancer), 0);
        assertEq(address(bountyPulse).balance, 0.016 ether); // arbiter fee still parked
    }

    function testCannotClaimTwice() public {
        uint256 id = _submittedWork();
        vm.prank(client);
        bountyPulse.approveWork(id);

        vm.startPrank(freelancer);
        bountyPulse.claimFunds();
        vm.expectRevert("Nothing to claim");
        bountyPulse.claimFunds();
        vm.stopPrank();
    }

    function testOnlyWinnerCanSubmitWork() public {
        uint256 id = _bountyWithBid();
        vm.deal(client, 1 ether);
        vm.prank(client);
        bountyPulse.fundEscrow{value: 0.8 ether}(id, 0);

        address intruder = makeAddr("intruder");
        vm.prank(intruder);
        bountyPulse.register("Ivan", "QmAvatar", BountyPulse.Role.Freelancer);

        vm.prank(intruder);
        vm.expectRevert("Not the winner");
        bountyPulse.submitWork(id, "QmStolen");
    }

    function testDisputeFreelancerAtFaultRefundsClientAndPenalises() public {
        uint256 id = _submittedWork();

        vm.prank(client);
        bountyPulse.raiseDispute(id);

        bountyPulse.resolveDispute(id, true); // test contract is the arbiter

        assertEq(bountyPulse.withdrawable(client), 0.8 ether); // full refund, no fee
        assertEq(bountyPulse.withdrawable(freelancer), 0);
        assertEq(bountyPulse.getUser(freelancer).reputation, 70); // 100 - 30
    }

    function testDisputeClientAtFaultPaysFreelancerMinusFee() public {
        uint256 id = _submittedWork();

        vm.prank(client);
        bountyPulse.raiseDispute(id);

        bountyPulse.resolveDispute(id, false);

        assertEq(bountyPulse.withdrawable(freelancer), 0.784 ether);
        assertEq(bountyPulse.withdrawable(address(this)), 0.016 ether);
        assertEq(bountyPulse.getUser(freelancer).reputation, 100); // unchanged
    }

    /// An abandoned bounty must still be recoverable: the freelancer takes the escrow to
    /// Locked and then vanishes without ever calling submitWork.
    function testClientCanDisputeAbandonedBountyFromLocked() public {
        uint256 id = _bountyWithBid();
        vm.deal(client, 1 ether);
        vm.prank(client);
        bountyPulse.fundEscrow{value: 0.8 ether}(id, 0);

        // No submitWork call at all - the freelancer has ghosted.
        vm.prank(client);
        bountyPulse.raiseDispute(id);

        bountyPulse.resolveDispute(id, true);

        assertEq(bountyPulse.withdrawable(client), 0.8 ether);
        assertEq(bountyPulse.getUser(freelancer).reputation, 70);
        assertEq(uint256(bountyPulse.getBounty(id).status), uint256(BountyPulse.Status.Resolved));

        // And the client can actually get the ETH back out.
        vm.prank(client);
        bountyPulse.claimFunds();
        assertEq(client.balance, 1 ether);
        assertEq(address(bountyPulse).balance, 0);
    }

    function testCannotDisputeAnOpenBounty() public {
        uint256 id = _bountyWithBid(); // funded by nobody, still Open

        vm.prank(client);
        vm.expectRevert("Nothing to dispute");
        bountyPulse.raiseDispute(id);
    }

    function testOnlyArbiterCanResolve() public {
        uint256 id = _submittedWork();
        vm.prank(client);
        bountyPulse.raiseDispute(id);

        vm.prank(client);
        vm.expectRevert("Not arbiter");
        bountyPulse.resolveDispute(id, true);
    }

    /// Runs one full bounty to a lost dispute, costing the freelancer 30 reputation.
    function _loseOneDispute() internal {
        vm.prank(client);
        uint256 id = bountyPulse.postBounty(1 ether, "QmDetails");
        vm.prank(freelancer);
        bountyPulse.placeBid(id, 0.8 ether);
        vm.prank(client);
        bountyPulse.fundEscrow{value: 0.8 ether}(id, 0);
        vm.prank(freelancer);
        bountyPulse.submitWork(id, "QmWorkFile");
        vm.prank(client);
        bountyPulse.raiseDispute(id);
        bountyPulse.resolveDispute(id, true);
    }

    /// The Section 2 gate, now testable: three lost disputes drop 100 -> 70 -> 40 -> 10.
    function testReputationGateBlocksBiddingBelow40() public {
        _registerBoth();
        vm.deal(client, 10 ether);

        _loseOneDispute(); // 100 -> 70
        _loseOneDispute(); // 70  -> 40
        _loseOneDispute(); // 40  -> 10
        assertEq(bountyPulse.getUser(freelancer).reputation, 10);

        vm.prank(client);
        uint256 blocked = bountyPulse.postBounty(1 ether, "QmDetails");
        vm.prank(freelancer);
        vm.expectRevert("Reputation too low");
        bountyPulse.placeBid(blocked, 0.5 ether);
    }

    /// Reputation is unsigned, so the penalty must clamp at zero instead of underflowing.
    /// Reaching zero needs two bounties won *while* reputation is still 40, because a
    /// single penalty can only ever take 40 down to 10.
    function testReputationClampsAtZero() public {
        _registerBoth();
        vm.deal(client, 10 ether);

        _loseOneDispute(); // 100 -> 70
        _loseOneDispute(); // 70  -> 40

        // Win two bounties concurrently, before either penalty lands.
        vm.startPrank(client);
        uint256 a = bountyPulse.postBounty(1 ether, "QmDetails");
        uint256 b = bountyPulse.postBounty(1 ether, "QmDetails");
        vm.stopPrank();

        vm.startPrank(freelancer);
        bountyPulse.placeBid(a, 0.8 ether);
        bountyPulse.placeBid(b, 0.8 ether);
        vm.stopPrank();

        vm.startPrank(client);
        bountyPulse.fundEscrow{value: 0.8 ether}(a, 0);
        bountyPulse.fundEscrow{value: 0.8 ether}(b, 0);
        vm.stopPrank();

        vm.startPrank(freelancer);
        bountyPulse.submitWork(a, "QmWorkFile");
        bountyPulse.submitWork(b, "QmWorkFile");
        vm.stopPrank();

        vm.startPrank(client);
        bountyPulse.raiseDispute(a);
        bountyPulse.raiseDispute(b);
        vm.stopPrank();

        bountyPulse.resolveDispute(a, true); // 40 -> 10
        assertEq(bountyPulse.getUser(freelancer).reputation, 10);

        bountyPulse.resolveDispute(b, true); // 10 - 30 would underflow, so clamp to 0
        assertEq(bountyPulse.getUser(freelancer).reputation, 0);
    }

    /// placeBid is non-payable, so the EVM rejects any attached ETH outright.
    function testBiddingWithEthReverts() public {
        _registerBoth();
        vm.prank(client);
        uint256 id = bountyPulse.postBounty(1 ether, "QmDetails");

        vm.deal(freelancer, 1 ether);
        vm.prank(freelancer);
        (bool ok,) = address(bountyPulse).call{value: 0.5 ether}(
            abi.encodeWithSignature("placeBid(uint256,uint256)", id, 0.5 ether)
        );
        assertFalse(ok, "non-payable function must reject ETH");
    }
}
