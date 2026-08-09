// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BountyPulse {
    enum Role {
        None,
        Client,
        Freelancer,
        Arbiter
    }

    enum Status {
        Open,
        Locked,
        Submitted,
        Resolved,
        Disputed
    }

    struct User {
        string name;
        string avatarCID;
        Role role;
        uint256 reputation;
        bool registered;
    }

    struct Bounty {
        address client;
        address winner;
        uint256 maxBudget;
        uint256 escrow;
        string detailsCID;
        string workCID;
        Status status;
    }

    struct Bid {
        address freelancer;
        uint256 amount;
    }

    uint256 public constant STARTING_REPUTATION = 100;
    uint256 public constant MIN_REPUTATION_TO_BID = 40;
    uint256 public constant PLATFORM_FEE_PERCENT = 2;
    uint256 public constant REPUTATION_REWARD = 15;
    uint256 public constant REPUTATION_PENALTY = 30;

    address public arbiter;
    mapping(address => User) public users;
    mapping(address => uint256) public withdrawable;

    Bounty[] public bounties;
    mapping(uint256 => Bid[]) public bids;
    mapping(uint256 => mapping(address => bool)) public hasBid;

    event UserRegistered(address indexed wallet, string name, Role role, string avatarCID);
    event BountyPosted(uint256 indexed bountyId, address indexed client, uint256 maxBudget, string detailsCID);
    event BidPlaced(uint256 indexed bountyId, address indexed freelancer, uint256 amount);
    event EscrowFunded(uint256 indexed bountyId, address indexed freelancer, uint256 amount);
    event ExcessRefunded(uint256 indexed bountyId, address indexed client, uint256 amount);
    event WorkSubmitted(uint256 indexed bountyId, address indexed freelancer, string workCID);
    event WorkApproved(uint256 indexed bountyId, address indexed freelancer, uint256 payout, uint256 fee);
    event DisputeRaised(uint256 indexed bountyId, address indexed client);
    event DisputeResolved(uint256 indexed bountyId, bool freelancerAtFault, uint256 amount);
    event ReputationChanged(address indexed freelancer, uint256 newScore);
    event FundsClaimed(address indexed wallet, uint256 amount);

    constructor() {
        arbiter = msg.sender;
        users[msg.sender] =
            User({name: "Platform Arbiter", avatarCID: "", role: Role.Arbiter, reputation: 0, registered: true});
    }

    modifier onlyArbiter() {
        require(msg.sender == arbiter, "Not arbiter");
        _;
    }

    modifier onlyRole(Role required) {
        require(users[msg.sender].role == required, "Wrong role");
        _;
    }

    modifier bountyExists(uint256 bountyId) {
        require(bountyId < bounties.length, "No such bounty");
        _;
    }

    function register(string calldata name, string calldata avatarCID, Role role) external {
        require(!users[msg.sender].registered, "Already registered");
        require(role == Role.Client || role == Role.Freelancer, "Pick Client or Freelancer");
        require(bytes(name).length > 0, "Name required");

        users[msg.sender] = User({
            name: name,
            avatarCID: avatarCID,
            role: role,
            reputation: role == Role.Freelancer ? STARTING_REPUTATION : 0,
            registered: true
        });

        emit UserRegistered(msg.sender, name, role, avatarCID);
    }

    function getUser(address wallet) external view returns (User memory) {
        return users[wallet];
    }

    /// @notice Client advertises a gig. Non-payable: money is only locked later, at funding.
    function postBounty(uint256 maxBudget, string calldata detailsCID)
        external
        onlyRole(Role.Client)
        returns (uint256 bountyId)
    {
        require(maxBudget > 0, "Budget must be > 0");
        require(bytes(detailsCID).length > 0, "Details CID required");

        bounties.push(
            Bounty({
                client: msg.sender,
                winner: address(0),
                maxBudget: maxBudget,
                escrow: 0,
                detailsCID: detailsCID,
                workCID: "",
                status: Status.Open
            })
        );

        bountyId = bounties.length - 1;
        emit BountyPosted(bountyId, msg.sender, maxBudget, detailsCID);
    }

    /// @notice Freelancer quotes an asking price. Non-payable by design - a bid is a
    ///         promise, not a payment. No ETH moves until the client funds escrow.
    function placeBid(uint256 bountyId, uint256 amount) external onlyRole(Role.Freelancer) bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(bounty.status == Status.Open, "Bounty not open");
        require(amount > 0, "Bid must be > 0");
        require(amount <= bounty.maxBudget, "Bid exceeds budget");
        require(users[msg.sender].reputation >= MIN_REPUTATION_TO_BID, "Reputation too low");
        require(!hasBid[bountyId][msg.sender], "Already bid");

        bids[bountyId].push(Bid({freelancer: msg.sender, amount: amount}));
        hasBid[bountyId][msg.sender] = true;

        emit BidPlaced(bountyId, msg.sender, amount);
    }

    /// @notice Client picks a winning bid and locks its exact value into escrow.
    /// @dev Underpaying reverts the whole transaction; overpaying is accepted at the
    ///      bid price and the surplus is returned in this same transaction.
    function fundEscrow(uint256 bountyId, uint256 bidIndex)
        external
        payable
        onlyRole(Role.Client)
        bountyExists(bountyId)
    {
        Bounty storage bounty = bounties[bountyId];

        require(msg.sender == bounty.client, "Not your bounty");
        require(bounty.status == Status.Open, "Bounty not open");
        require(bidIndex < bids[bountyId].length, "No such bid");

        Bid memory chosen = bids[bountyId][bidIndex];
        require(msg.value >= chosen.amount, "Send exact bid amount");

        // Effects first: state is final before any ETH leaves the contract.
        bounty.winner = chosen.freelancer;
        bounty.escrow = chosen.amount;
        bounty.status = Status.Locked;

        emit EscrowFunded(bountyId, chosen.freelancer, chosen.amount);

        // Interaction last.
        uint256 excess = msg.value - chosen.amount;
        if (excess > 0) {
            (bool refunded,) = payable(msg.sender).call{value: excess}("");
            require(refunded, "Refund failed");
            emit ExcessRefunded(bountyId, msg.sender, excess);
        }
    }

    /// @notice Winning freelancer hands in the deliverable as an IPFS CID.
    function submitWork(uint256 bountyId, string calldata workCID)
        external
        onlyRole(Role.Freelancer)
        bountyExists(bountyId)
    {
        Bounty storage bounty = bounties[bountyId];

        require(msg.sender == bounty.winner, "Not the winner");
        require(bounty.status == Status.Locked, "Bounty not locked");
        require(bytes(workCID).length > 0, "Work CID required");

        bounty.workCID = workCID;
        bounty.status = Status.Submitted;

        emit WorkSubmitted(bountyId, msg.sender, workCID);
    }

    /// @notice Client accepts the work: 2% to the arbiter, 98% credited to the freelancer.
    /// @dev No ETH is sent here - balances are credited and withdrawn later (pull payment).
    function approveWork(uint256 bountyId) external onlyRole(Role.Client) bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(msg.sender == bounty.client, "Not your bounty");
        require(bounty.status == Status.Submitted, "Work not submitted");

        uint256 amount = bounty.escrow;
        uint256 fee = (amount * PLATFORM_FEE_PERCENT) / 100;
        uint256 payout = amount - fee;

        // Zero the escrow before crediting so a bounty can never pay out twice.
        bounty.escrow = 0;
        bounty.status = Status.Resolved;

        withdrawable[arbiter] += fee;
        withdrawable[bounty.winner] += payout;

        _rewardReputation(bounty.winner);

        emit WorkApproved(bountyId, bounty.winner, payout, fee);
    }

    /// @notice Client escalates to the arbiter, either because the delivered work is
    ///         unsatisfactory or because a funded freelancer never delivered at all.
    /// @dev Allowing this from Locked as well as Submitted is what stops escrow becoming
    ///      permanently unrecoverable when a winning freelancer abandons the job.
    function raiseDispute(uint256 bountyId) external onlyRole(Role.Client) bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(msg.sender == bounty.client, "Not your bounty");
        require(bounty.status == Status.Submitted || bounty.status == Status.Locked, "Nothing to dispute");

        bounty.status = Status.Disputed;
        emit DisputeRaised(bountyId, msg.sender);
    }

    /// @notice Arbiter settles a dispute.
    /// @param freelancerAtFault true  -> full escrow refunded to the client, freelancer loses 30 reputation.
    ///                          false -> freelancer is paid the escrow minus the 2% platform fee.
    function resolveDispute(uint256 bountyId, bool freelancerAtFault) external onlyArbiter bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];
        require(bounty.status == Status.Disputed, "Not disputed");

        uint256 amount = bounty.escrow;
        bounty.escrow = 0;
        bounty.status = Status.Resolved;

        uint256 settled;
        if (freelancerAtFault) {
            settled = amount;
            withdrawable[bounty.client] += amount;
            _penaliseReputation(bounty.winner);
        } else {
            uint256 fee = (amount * PLATFORM_FEE_PERCENT) / 100;
            settled = amount - fee;
            withdrawable[arbiter] += fee;
            withdrawable[bounty.winner] += settled;
        }

        emit DisputeResolved(bountyId, freelancerAtFault, settled);
    }

    /// @notice Pull payment: everyone withdraws their own accumulated balance.
    function claimFunds() external {
        uint256 amount = withdrawable[msg.sender];
        require(amount > 0, "Nothing to claim");

        // Zero the ledger BEFORE sending, so a re-entrant call finds nothing left.
        withdrawable[msg.sender] = 0;

        (bool sent,) = payable(msg.sender).call{value: amount}("");
        require(sent, "Withdraw failed");

        emit FundsClaimed(msg.sender, amount);
    }

    function _rewardReputation(address freelancer) internal {
        uint256 updated = users[freelancer].reputation + REPUTATION_REWARD;
        users[freelancer].reputation = updated;
        emit ReputationChanged(freelancer, updated);
    }

    /// @dev Subtracting from an unsigned integer below zero reverts, so clamp at 0.
    function _penaliseReputation(address freelancer) internal {
        uint256 current = users[freelancer].reputation;
        uint256 updated = current > REPUTATION_PENALTY ? current - REPUTATION_PENALTY : 0;
        users[freelancer].reputation = updated;
        emit ReputationChanged(freelancer, updated);
    }

    // ---------------------------------------------------------------------
    // View helpers - free to call, used by the frontend feed.
    // ---------------------------------------------------------------------

    function getAllBounties() external view returns (Bounty[] memory) {
        return bounties;
    }

    function getBounty(uint256 bountyId) external view bountyExists(bountyId) returns (Bounty memory) {
        return bounties[bountyId];
    }

    function getBids(uint256 bountyId) external view bountyExists(bountyId) returns (Bid[] memory) {
        return bids[bountyId];
    }

    function bountyCount() external view returns (uint256) {
        return bounties.length;
    }
}
