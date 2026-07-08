// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ReuniteEscrow.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDT is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {
        _mint(msg.sender, 1000000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}

contract ReuniteEscrowTest is Test {
    ReuniteEscrow public escrow;
    MockUSDT public usdt;

    address public reporter = address(0x1);
    address public finder = address(0x2);
    address public other = address(0x3);

    bytes32 public alertId = keccak256("alert-1");
    uint256 public bountyAmount = 100 * 10 ** 6; // 100 USDT
    uint256 public timeout = 1 hours;

    event BountyPosted(bytes32 indexed alertId, address indexed reporter, uint256 amount);
    event FinderConfirmed(bytes32 indexed alertId, address indexed finder, uint256 amount);
    event BountyRefunded(bytes32 indexed alertId, address indexed reporter, uint256 amount);

    function setUp() public {
        usdt = new MockUSDT();
        escrow = new ReuniteEscrow(address(usdt), timeout);

        // Fund reporter
        usdt.mint(reporter, bountyAmount * 10);

        // Reporter approves escrow contract
        vm.prank(reporter);
        usdt.approve(address(escrow), type(uint256).max);
    }

    function testDeposit() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        ReuniteEscrow.Alert memory alert = escrow.getAlert(alertId);
        assertEq(alert.reporter, reporter);
        assertEq(alert.finder, address(0));
        assertEq(alert.amount, bountyAmount);
        assertEq(alert.createdAt, block.timestamp);
        assertEq(uint256(alert.status), uint256(ReuniteEscrow.Status.Active));
        assertEq(usdt.balanceOf(address(escrow)), bountyAmount);
    }

    function testConfirmPayout() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        uint256 finderBalanceBefore = usdt.balanceOf(finder);

        vm.prank(reporter);
        escrow.confirmFinder(alertId, finder);

        ReuniteEscrow.Alert memory alert = escrow.getAlert(alertId);
        assertEq(alert.finder, finder);
        assertEq(uint256(alert.status), uint256(ReuniteEscrow.Status.Paid));
        assertEq(usdt.balanceOf(finder), finderBalanceBefore + bountyAmount);
        assertEq(usdt.balanceOf(address(escrow)), 0);
    }

    function testTimeoutRefund() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        uint256 reporterBalanceBefore = usdt.balanceOf(reporter);

        // Warp to after timeout
        vm.warp(block.timestamp + timeout);

        vm.prank(reporter);
        escrow.reclaim(alertId);

        ReuniteEscrow.Alert memory alert = escrow.getAlert(alertId);
        assertEq(uint256(alert.status), uint256(ReuniteEscrow.Status.Refunded));
        assertEq(usdt.balanceOf(reporter), reporterBalanceBefore + bountyAmount);
        assertEq(usdt.balanceOf(address(escrow)), 0);
    }

    function testDuplicateAlertRevert() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.expectRevert(abi.encodeWithSelector(ReuniteEscrow.DuplicateAlertID.selector, alertId));
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);
    }

    function testZeroBountyRevert() public {
        vm.expectRevert(ReuniteEscrow.ZeroBounty.selector);
        vm.prank(reporter);
        escrow.postBounty(alertId, 0);
    }

    function testOnlyReporterConfirm() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.expectRevert(ReuniteEscrow.OnlyReporter.selector);
        vm.prank(other);
        escrow.confirmFinder(alertId, finder);
    }

    function testOnlyReporterRefund() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.warp(block.timestamp + timeout);

        vm.expectRevert(ReuniteEscrow.OnlyReporter.selector);
        vm.prank(other);
        escrow.reclaim(alertId);
    }

    // --- Added testConstructorRevertZeroAddress ---
    function testConstructorRevertZeroAddress() public {
        vm.expectRevert(ReuniteEscrow.ZeroTokenAddress.selector);
        new ReuniteEscrow(address(0), timeout);
    }

    function testDoublePayoutRevert() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.prank(reporter);
        escrow.confirmFinder(alertId, finder);

        vm.expectRevert(ReuniteEscrow.CannotConfirmTwice.selector);
        vm.prank(reporter);
        escrow.confirmFinder(alertId, finder);
    }

    function testRefundBeforeTimeoutRevert() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.expectRevert(abi.encodeWithSelector(ReuniteEscrow.ReclaimOnlyAfterTimeout.selector, timeout));
        vm.prank(reporter);
        escrow.reclaim(alertId);
    }

    function testPayoutAfterRefundRevert() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.warp(block.timestamp + timeout);

        vm.prank(reporter);
        escrow.reclaim(alertId);

        vm.expectRevert(ReuniteEscrow.CannotPayoutAfterRefund.selector);
        vm.prank(reporter);
        escrow.confirmFinder(alertId, finder);
    }

    function testRefundAfterPayoutRevert() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.prank(reporter);
        escrow.confirmFinder(alertId, finder);

        vm.warp(block.timestamp + timeout);

        vm.expectRevert(ReuniteEscrow.CannotRefundAfterPayout.selector);
        vm.prank(reporter);
        escrow.reclaim(alertId);
    }

    function testWrongFinderRevert() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.expectRevert(ReuniteEscrow.ZeroFinder.selector);
        vm.prank(reporter);
        escrow.confirmFinder(alertId, address(0));
    }

    function testNoAllowanceRevert() public {
        address unapprovedReporter = address(0x4);
        usdt.mint(unapprovedReporter, bountyAmount);

        vm.expectRevert();
        vm.prank(unapprovedReporter);
        escrow.postBounty(alertId, bountyAmount);
    }

    function testInsufficientBalanceRevert() public {
        address brokeReporter = address(0x5);
        vm.prank(brokeReporter);
        usdt.approve(address(escrow), type(uint256).max);

        vm.expectRevert();
        vm.prank(brokeReporter);
        escrow.postBounty(alertId, bountyAmount);
    }

    // ==========================================
    //            ADDITIONAL FUZZ TESTS
    // ==========================================

    function testFuzzDeposit(uint256 amount) public {
        vm.assume(amount > 0 && amount <= 1000000 * 10 ** 6);

        usdt.mint(reporter, amount);
        vm.prank(reporter);
        usdt.approve(address(escrow), amount);

        bytes32 fuzzedAlertId = keccak256(abi.encodePacked("fuzz-alert-", amount));
        vm.prank(reporter);
        escrow.postBounty(fuzzedAlertId, amount);

        ReuniteEscrow.Alert memory alert = escrow.getAlert(fuzzedAlertId);
        assertEq(alert.amount, amount);
    }

    function testFuzzTimeoutRefund(uint256 warpTime) public {
        vm.assume(warpTime >= timeout && warpTime < 100 * 365 days);

        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.warp(block.timestamp + warpTime);

        vm.prank(reporter);
        escrow.reclaim(alertId);

        ReuniteEscrow.Alert memory alert = escrow.getAlert(alertId);
        assertEq(uint256(alert.status), uint256(ReuniteEscrow.Status.Refunded));
    }

    function testReclaimExactlyAtTimeout() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.warp(block.timestamp + timeout);

        vm.prank(reporter);
        escrow.reclaim(alertId);

        ReuniteEscrow.Alert memory alert = escrow.getAlert(alertId);
        assertEq(uint256(alert.status), uint256(ReuniteEscrow.Status.Refunded));
    }

    // ==========================================
    //         EVENT EMISSION VERIFICATION
    // ==========================================

    function testEventBountyPosted() public {
        vm.expectEmit(true, true, false, true);
        emit BountyPosted(alertId, reporter, bountyAmount);

        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);
    }

    function testEventFinderConfirmed() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.expectEmit(true, true, false, true);
        emit FinderConfirmed(alertId, finder, bountyAmount);

        vm.prank(reporter);
        escrow.confirmFinder(alertId, finder);
    }

    function testEventBountyRefunded() public {
        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.warp(block.timestamp + timeout);

        vm.expectEmit(true, true, false, true);
        emit BountyRefunded(alertId, reporter, bountyAmount);

        vm.prank(reporter);
        escrow.reclaim(alertId);
    }

    // ==========================================
    //             STORAGE ISOLATION
    // ==========================================

    function testStorageIsolation() public {
        bytes32 alert1 = keccak256("alert-isolation-1");
        bytes32 alert2 = keccak256("alert-isolation-2");

        vm.prank(reporter);
        escrow.postBounty(alert1, bountyAmount);

        vm.prank(reporter);
        escrow.postBounty(alert2, bountyAmount * 2);

        ReuniteEscrow.Alert memory state1 = escrow.getAlert(alert1);
        ReuniteEscrow.Alert memory state2 = escrow.getAlert(alert2);

        assertEq(state1.amount, bountyAmount);
        assertEq(state2.amount, bountyAmount * 2);
    }

    function testMultipleReportersAndAlerts() public {
        address reporter2 = address(0x9);
        uint256 amount2 = 50 * 10 ** 6;
        bytes32 alert2 = keccak256("alert-reporter-2");

        usdt.mint(reporter2, amount2);
        vm.prank(reporter2);
        usdt.approve(address(escrow), type(uint256).max);

        vm.prank(reporter);
        escrow.postBounty(alertId, bountyAmount);

        vm.prank(reporter2);
        escrow.postBounty(alert2, amount2);

        vm.prank(reporter);
        escrow.confirmFinder(alertId, finder);

        vm.warp(block.timestamp + timeout);

        vm.prank(reporter2);
        escrow.reclaim(alert2);

        ReuniteEscrow.Alert memory state1 = escrow.getAlert(alertId);
        ReuniteEscrow.Alert memory state2 = escrow.getAlert(alert2);

        assertEq(uint256(state1.status), uint256(ReuniteEscrow.Status.Paid));
        assertEq(uint256(state2.status), uint256(ReuniteEscrow.Status.Refunded));
    }
}
