// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ReuniteEscrow {
    using SafeERC20 for IERC20;

    enum Status {
        Active,
        Paid,
        Refunded
    }

    struct Alert {
        address reporter; // 20 bytes - Slot 0 (packed with status)
        Status status; // 1 byte   - Slot 0
        address finder; // 20 bytes - Slot 1 (packed with createdAt)
        uint64 createdAt; // 8 bytes  - Slot 1
        uint256 amount; // 32 bytes - Slot 2
    }

    IERC20 public immutable usdt;
    uint256 public immutable REFUND_TIMEOUT;

    mapping(bytes32 => Alert) private _alerts;

    // Custom Errors
    error ZeroBounty();
    error DuplicateAlertID(bytes32 alertId);
    error AlertDoesNotExist(bytes32 alertId);
    error OnlyReporter();
    error ZeroFinder();
    error CannotConfirmTwice();
    error CannotPayoutAfterRefund();
    error CannotRefundTwice();
    error CannotRefundAfterPayout();
    error ReclaimOnlyAfterTimeout(uint256 timeRemaining);
    error ZeroTokenAddress();

    event BountyPosted(bytes32 indexed alertId, address indexed reporter, uint256 amount);
    event FinderConfirmed(bytes32 indexed alertId, address indexed finder, uint256 amount);
    event BountyRefunded(bytes32 indexed alertId, address indexed reporter, uint256 amount);

    constructor(address _usdt, uint256 _refundTimeout) {
        if (_usdt == address(0)) revert ZeroTokenAddress();
        usdt = IERC20(_usdt);
        REFUND_TIMEOUT = _refundTimeout;
    }

    function postBounty(bytes32 alertId, uint256 amount) external {
        if (amount == 0) revert ZeroBounty();
        if (_alerts[alertId].reporter != address(0)) revert DuplicateAlertID(alertId);

        _alerts[alertId] = Alert({
            reporter: msg.sender,
            status: Status.Active,
            finder: address(0),
            createdAt: uint64(block.timestamp),
            amount: amount
        });

        usdt.safeTransferFrom(msg.sender, address(this), amount);

        emit BountyPosted(alertId, msg.sender, amount);
    }

    function confirmFinder(bytes32 alertId, address finder) external {
        Alert storage alert = _alerts[alertId];
        if (alert.reporter == address(0)) revert AlertDoesNotExist(alertId);
        if (msg.sender != alert.reporter) revert OnlyReporter();
        if (finder == address(0)) revert ZeroFinder();
        if (alert.status == Status.Paid) revert CannotConfirmTwice();
        if (alert.status == Status.Refunded) revert CannotPayoutAfterRefund();

        alert.finder = finder;
        alert.status = Status.Paid;

        uint256 bountyAmount = alert.amount;
        usdt.safeTransfer(finder, bountyAmount);

        emit FinderConfirmed(alertId, finder, bountyAmount);
    }

    function reclaim(bytes32 alertId) external {
        Alert storage alert = _alerts[alertId];
        if (alert.reporter == address(0)) revert AlertDoesNotExist(alertId);
        if (msg.sender != alert.reporter) revert OnlyReporter();
        if (alert.status == Status.Refunded) revert CannotRefundTwice();
        if (alert.status == Status.Paid) revert CannotRefundAfterPayout();
        if (block.timestamp < alert.createdAt + REFUND_TIMEOUT) {
            revert ReclaimOnlyAfterTimeout((alert.createdAt + REFUND_TIMEOUT) - block.timestamp);
        }

        alert.status = Status.Refunded;

        uint256 refundAmount = alert.amount;
        usdt.safeTransfer(alert.reporter, refundAmount);

        emit BountyRefunded(alertId, alert.reporter, refundAmount);
    }

    function getAlert(bytes32 alertId) external view returns (Alert memory) {
        return _alerts[alertId];
    }
}
