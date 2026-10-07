// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "./Base.t.sol";
import {Escrow} from "../src/accounts/Escrow.sol";
import {IEscrow} from "../src/accounts/interfaces/IEscrow.sol";
import {MockCounter} from "./utils/mocks/MockCounter.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @dev H2 regression: allowance increases and untracked outflows count as spend.
contract GuardedExecutorSpendGuardTest is BaseTest {
    address internal constant _BEEF = address(0xBEEF);
    bytes4 internal constant _BALANCE_READ_FAILED = bytes4(keccak256("SpendBalanceReadFailed()"));

    /// @dev Checker that authorizes every call. Spend limits still apply.
    YesCallChecker internal yesChecker;

    function setUp() public virtual override {
        super.setUp();
        yesChecker = new YesCallChecker();
        assertEq(MockPaymentToken.increaseAllowance.selector, bytes4(0x39509351));
        assertEq(MockPaymentToken.increaseApproval.selector, bytes4(0xd73dd623));
    }

    /// @dev Intentional. A token with no spend period is not balance-metered, so a
    /// non-root key can move it with an unrecognized selector and nothing is charged.
    /// Set a period on every token that should be protected.
    function testIntended_NonRootMovesUnperiodedTokenUncharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        paymentToken.mint(d.eoa, 50 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(paymentToken);
        calls[0].data = abi.encodeWithSignature(
            "anotherTransfer(address,uint256)",
            _BEEF,
            50 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(d.eoa), 0);
        assertEq(paymentToken.balanceOf(_BEEF), 50 ether);
        assertEq(d.d.spendInfos(k.keyHash).length, 0);
    }

    function testIncreaseAllowanceBypassesSpendLimit() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Forever, 1);
        paymentToken.mint(d.eoa, 1000 ether);

        assertEq(
            _run(d, k, u, _increaseCall("increaseAllowance(address,uint256)", 1000 ether)),
            GuardedExecutor.ExceededSpendLimit.selector
        );
        assertEq(paymentToken.allowance(d.eoa, _BEEF), 0);
        assertEq(paymentToken.balanceOf(d.eoa), 1000 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
        _assertBeefCannotPull(d.eoa, 1000 ether);
    }

    function testIncreaseAllowanceWithoutSpendPermission() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        paymentToken.mint(d.eoa, 1000 ether);

        assertEq(
            _run(d, k, u, _increaseCall("increaseAllowance(address,uint256)", 1000 ether)),
            bytes4(keccak256("NoSpendPermissions()"))
        );
        assertEq(paymentToken.allowance(d.eoa, _BEEF), 0);
        assertEq(paymentToken.balanceOf(_BEEF), 0);
    }

    function testIncreaseApprovalBypassesSpendLimit() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Forever, 1);
        paymentToken.mint(d.eoa, 1000 ether);

        assertEq(
            _run(d, k, u, _increaseCall("increaseApproval(address,uint256)", 1000 ether)),
            GuardedExecutor.ExceededSpendLimit.selector
        );
        assertEq(paymentToken.allowance(d.eoa, _BEEF), 0);
        _assertBeefCannotPull(d.eoa, 1000 ether);
    }

    function testAnyKeyHashIncreaseAllowanceBypassesSpendLimit() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        vm.prank(d.eoa);
        d.d.setCanExecute(_ANY_KEYHASH, _ANY_TARGET, _ANY_FN_SEL, true);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Forever, 1);
        paymentToken.mint(d.eoa, 1e9);

        assertEq(
            _run(d, k, u, _increaseCall("increaseAllowance(address,uint256)", 1e9)),
            GuardedExecutor.ExceededSpendLimit.selector
        );
        assertEq(paymentToken.allowance(d.eoa, _BEEF), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
        _assertBeefCannotPull(d.eoa, 1e9);
    }

    function testCallCheckerIncreaseAllowanceBypassesSpendLimit() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        vm.prank(d.eoa);
        d.d.setCallChecker(k.keyHash, address(paymentToken), address(yesChecker));
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Forever, 1);
        paymentToken.mint(d.eoa, 1e9);

        assertEq(
            _run(d, k, u, _increaseCall("increaseAllowance(address,uint256)", 1e9)),
            GuardedExecutor.ExceededSpendLimit.selector
        );
        assertEq(paymentToken.allowance(d.eoa, _BEEF), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
        _assertBeefCannotPull(d.eoa, 1e9);
    }

    /// @dev Residual, locked on purpose. The root key approved the escrow, and this key has
    /// no spend period for the token. Calldata is not scanned, and the escrow contract does
    /// not report a token balance, so the pull is not charged.
    function testRootAllowanceWithoutSpendPeriodStaysUncovered() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        Escrow escrow = new Escrow();
        paymentToken.mint(d.eoa, 50 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(escrow), type(uint256).max);
        _allow(d, k.keyHash, address(escrow), _ANY_FN_SEL);

        assertEq(_run(d, k, u, _escrowCall(escrow, d.eoa, 50 ether)), bytes4(0));
        assertEq(paymentToken.balanceOf(d.eoa), 0);
        assertEq(paymentToken.balanceOf(address(escrow)), 50 ether);
    }

    /// @dev The spender has no `balanceOf`. The token is tracked because it has a period,
    /// so the pull is still charged.
    function testThirdPartyPullWithinSpendLimitIsCharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        Escrow escrow = new Escrow();
        paymentToken.mint(d.eoa, 50 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(escrow), type(uint256).max);
        _allow(d, k.keyHash, address(escrow), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 100 ether);

        assertEq(_run(d, k, u, _escrowCall(escrow, d.eoa, 50 ether)), bytes4(0));
        assertEq(paymentToken.balanceOf(address(escrow)), 50 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 50 ether);
    }

    function testInLimitTransferStillWorks() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        _allow(d, k.keyHash, address(paymentToken), bytes4(0xa9059cbb));
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);
        paymentToken.mint(d.eoa, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0] = _transferCall(address(paymentToken), _BEEF, 0.4 ether);

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(_BEEF), 0.4 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0.4 ether);
    }

    function testUntrackedSelectorWithinLimitIsCharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);
        paymentToken.mint(d.eoa, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(paymentToken);
        calls[0].data = abi.encodeWithSignature(
            "anotherTransfer(address,uint256)",
            _BEEF,
            0.4 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(_BEEF), 0.4 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0.4 ether);
    }

    function testApproveStillResetAfterBatch() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);
        paymentToken.mint(d.eoa, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(paymentToken);
        calls[0].data = abi.encodeWithSignature("approve(address,uint256)", _BEEF, 0.25 ether);

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.allowance(d.eoa, _BEEF), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0.25 ether);
    }

    function testIncreaseAllowanceWithinLimitIsChargedAndReset() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);
        paymentToken.mint(d.eoa, 1 ether);

        assertEq(
            _run(d, k, u, _increaseCall("increaseAllowance(address,uint256)", 0.25 ether)),
            bytes4(0)
        );
        assertEq(paymentToken.allowance(d.eoa, _BEEF), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0.25 ether);
        assertEq(paymentToken.balanceOf(_BEEF), 0);
        _assertBeefCannotPull(d.eoa, 0.25 ether);
    }

    /// @dev Mirrors `buildPermissionDefaults`: USDC transfer selector only, 10 tokens per day.
    function testDefaultWalletSessionTransferWithinDailyLimit() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        uint256 dayLimit = 10_000_000;
        _allow(d, k.keyHash, address(paymentToken), bytes4(0xa9059cbb));
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, dayLimit);
        // Leave enough balance that the second transfer fails the spend limit, not the token.
        paymentToken.mint(d.eoa, dayLimit + 1_000_000);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0] = _transferCall(address(paymentToken), _BEEF, 1_000_000);
        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(_BEEF), 1_000_000);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 1_000_000);

        calls[0] = _transferCall(address(paymentToken), _BEEF, dayLimit);
        assertEq(_run(d, k, u, calls), GuardedExecutor.ExceededSpendLimit.selector);
        assertEq(paymentToken.balanceOf(_BEEF), 1_000_000);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 1_000_000);
    }

    function testSuperAdminUntrackedTransferSkipsSpendGuard() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(true);
        paymentToken.mint(d.eoa, 50 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(paymentToken);
        calls[0].data = abi.encodeWithSignature(
            "anotherTransfer(address,uint256)",
            _BEEF,
            50 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(_BEEF), 50 ether);
    }

    function testRootExecutionSkipsSpendGuard() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        paymentToken.mint(d.eoa, 50 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(paymentToken);
        calls[0].data = abi.encodeWithSignature(
            "anotherTransfer(address,uint256)",
            _BEEF,
            50 ether
        );

        vm.prank(d.eoa);
        d.d.execute(_ERC7821_BATCH_EXECUTION_MODE, abi.encode(calls));
        assertEq(paymentToken.balanceOf(_BEEF), 50 ether);
    }

    function testNonTokenCallWithoutSpendLimitStillSucceeds() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockCounter counter = new MockCounter();
        _allow(d, k.keyHash, address(counter), _ANY_FN_SEL);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(counter);
        calls[0].data = abi.encodeWithSelector(MockCounter.increment.selector);

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(counter.counter(), 1);
    }

    /// @dev Two tokens that each have a period are charged their own amounts in one batch.
    function testSeveralTrackedTokensChargedInOneBatch() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockPaymentToken other = new MockPaymentToken();
        _allow(d, k.keyHash, address(paymentToken), bytes4(0xa9059cbb));
        _allow(d, k.keyHash, address(other), bytes4(0xa9059cbb));
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);
        _limit(d, k.keyHash, address(other), GuardedExecutor.SpendPeriod.Day, 1 ether);
        paymentToken.mint(d.eoa, 1 ether);
        other.mint(d.eoa, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](2);
        calls[0] = _transferCall(address(paymentToken), _BEEF, 0.2 ether);
        calls[1] = _transferCall(address(other), _BEEF, 0.5 ether);

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(_BEEF), 0.2 ether);
        assertEq(other.balanceOf(_BEEF), 0.5 ether);

        GuardedExecutor.SpendInfo[] memory infos = d.d.spendInfos(k.keyHash);
        assertEq(infos.length, 2);
        uint256 seen;
        for (uint256 i; i < infos.length; ++i) {
            if (infos[i].token == address(paymentToken)) {
                assertEq(infos[i].spent, 0.2 ether);
                seen += 1;
            } else if (infos[i].token == address(other)) {
                assertEq(infos[i].spent, 0.5 ether);
                seen += 1;
            }
        }
        assertEq(seen, 2);
    }

    /// @dev Same residual as a root allowance with no spend period. The token has no
    /// period, so it is not balance-metered, and the pull is not charged.
    function testHardcodedSpenderPullWithoutLimitStaysUncovered() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockHardcodedPuller puller = new MockHardcodedPuller(address(paymentToken));
        paymentToken.mint(d.eoa, 50 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(puller), type(uint256).max);
        _allow(d, k.keyHash, address(puller), _ANY_FN_SEL);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(puller);
        calls[0].data = abi.encodeWithSignature(
            "pull(address,address,uint256)",
            d.eoa,
            _BEEF,
            50 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(_BEEF), 50 ether);
    }

    /// @dev vault.withdraw credits the account, then an untracked transfer spends it.
    /// The batch net is zero. The charge is the transfer.
    function testVaultWithdrawThenUntrackedTransferIsNotMasked() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockVault vault = new MockVault(address(paymentToken));
        paymentToken.mint(address(vault), 50 ether);
        _allow(d, k.keyHash, address(vault), _ANY_FN_SEL);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](2);
        calls[0].to = address(vault);
        calls[0].data = abi.encodeWithSignature("withdraw(uint256)", 50 ether);
        calls[1].to = address(paymentToken);
        calls[1].data = abi.encodeWithSignature(
            "anotherTransfer(address,uint256)",
            _BEEF,
            50 ether
        );

        assertEq(_run(d, k, u, calls), GuardedExecutor.ExceededSpendLimit.selector);
        assertEq(paymentToken.balanceOf(_BEEF), 0);
        assertEq(paymentToken.balanceOf(d.eoa), 0);
        assertEq(paymentToken.balanceOf(address(vault)), 50 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev Refund an old escrow into the account, escrow that balance to the attacker,
    /// then refund the new escrow to the attacker. The account's batch net is zero.
    function testEscrowRefundThenEscrowToAttackerIsNotMasked() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        Escrow escrow = new Escrow();
        paymentToken.mint(d.eoa, 45 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(escrow), type(uint256).max);

        IEscrow.Escrow memory oldItem = _escrowItem(
            bytes12(uint96(1)),
            d.eoa,
            address(0x3333),
            40 ether,
            40 ether,
            block.timestamp - 1
        );
        IEscrow.Escrow[] memory seeded = new IEscrow.Escrow[](1);
        seeded[0] = oldItem;
        vm.prank(d.eoa);
        escrow.escrow(seeded);
        assertEq(paymentToken.balanceOf(d.eoa), 5 ether);

        IEscrow.Escrow memory fresh = _escrowItem(
            bytes12(uint96(2)),
            d.eoa,
            _BEEF,
            40 ether,
            0,
            block.timestamp - 1
        );

        _allow(d, k.keyHash, address(escrow), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);

        bytes32[] memory oldIds = new bytes32[](1);
        oldIds[0] = keccak256(abi.encode(oldItem));
        bytes32[] memory newIds = new bytes32[](1);
        newIds[0] = keccak256(abi.encode(fresh));
        IEscrow.Escrow[] memory freshItems = new IEscrow.Escrow[](1);
        freshItems[0] = fresh;

        ERC7821.Call[] memory calls = new ERC7821.Call[](3);
        calls[0].to = address(escrow);
        calls[0].data = abi.encodeCall(escrow.refund, (oldIds));
        calls[1].to = address(escrow);
        calls[1].data = abi.encodeCall(escrow.escrow, (freshItems));
        calls[2].to = address(escrow);
        calls[2].data = abi.encodeCall(escrow.refund, (newIds));

        assertEq(_run(d, k, u, calls), GuardedExecutor.ExceededSpendLimit.selector);
        assertEq(paymentToken.balanceOf(d.eoa), 5 ether);
        assertEq(paymentToken.balanceOf(_BEEF), 0);
        assertEq(paymentToken.balanceOf(address(escrow)), 40 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev A rebase mint in the same batch must not hide the following transfer.
    function testRebaseMintDoesNotMaskUntrackedTransfer() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockYieldToken token = new MockYieldToken();
        token.mint(d.eoa, 10 ether);
        _allow(d, k.keyHash, address(token), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(token), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](2);
        calls[0].to = address(token);
        calls[0].data = abi.encodeWithSignature("sync(uint256)", 40 ether);
        calls[1].to = address(token);
        calls[1].data = abi.encodeWithSignature(
            "anotherTransfer(address,uint256)",
            _BEEF,
            40 ether
        );

        assertEq(_run(d, k, u, calls), GuardedExecutor.ExceededSpendLimit.selector);
        assertEq(token.balanceOf(_BEEF), 0);
        assertEq(token.balanceOf(d.eoa), 10 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev A recognized `transfer` debits a fee on top of the calldata amount. A later
    /// mint of exactly that fee makes the batch net equal the calldata amount. The charge
    /// stays the full per-call decrease.
    function testInflowDoesNotReduceRecognizedSelectorCharge() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockFeeOnTransferToken token = new MockFeeOnTransferToken();
        token.setFee(2 ether);
        token.mint(d.eoa, 20 ether);
        _allow(d, k.keyHash, address(token), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(token), GuardedExecutor.SpendPeriod.Day, 11 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](2);
        calls[0] = _transferCall(address(token), _BEEF, 10 ether);
        calls[1].to = address(token);
        calls[1].data = abi.encodeWithSignature("mint(address,uint256)", d.eoa, 2 ether);

        assertEq(_run(d, k, u, calls), GuardedExecutor.ExceededSpendLimit.selector);
        assertEq(token.balanceOf(_BEEF), 0);
        assertEq(token.balanceOf(d.eoa), 20 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    function testRevertingBalanceOfRevertsBatch() public {
        _balanceReadFails(1);
    }

    function testShortBalanceOfRevertsBatch() public {
        _balanceReadFails(2);
    }

    function _balanceReadFails(uint8 mode) internal {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockBrokenBalanceToken token = new MockBrokenBalanceToken();
        token.mint(d.eoa, 7 ether);
        token.setMode(mode);
        _allow(d, k.keyHash, address(token), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(token), GuardedExecutor.SpendPeriod.Day, 100 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(token);
        calls[0].data = abi.encodeWithSignature(
            "anotherTransfer(address,uint256)",
            _BEEF,
            7 ether
        );

        assertEq(_run(d, k, u, calls), _BALANCE_READ_FAILED);
        token.setMode(0);
        assertEq(token.balanceOf(_BEEF), 0);
        assertEq(token.balanceOf(d.eoa), 7 ether);
    }

    bytes4 internal constant _REENTRANCY = bytes4(keccak256("GuardedReentrancy()"));

    /// @dev (a) A router reenters `execute`, withdraws 50, then `transferFrom`s 50.
    /// The nested execute reverts. The outer batch reverts with it.
    function testSameCallReentrantWithdrawIsBlocked() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockVault vault = new MockVault(address(paymentToken));
        MockReentrantRouter router = new MockReentrantRouter();
        paymentToken.mint(d.eoa, 10 ether);
        paymentToken.mint(address(vault), 50 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(router), type(uint256).max);
        _allow(d, k.keyHash, address(router), _ANY_FN_SEL);
        _allow(d, k.keyHash, address(vault), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory inner = new ERC7821.Call[](1);
        inner[0].to = address(vault);
        inner[0].data = abi.encodeWithSignature("withdraw(uint256)", 50 ether);
        uint256 innerNonce = d.d.getNonce(0) + 1;
        bytes memory executionData = abi.encode(
            inner,
            abi.encodePacked(innerNonce, _sig(k, d.d.computeDigest(inner, innerNonce)))
        );

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(router);
        calls[0].data = abi.encodeWithSelector(
            MockReentrantRouter.attack.selector,
            address(d.d),
            address(paymentToken),
            _BEEF,
            50 ether,
            _ERC7821_BATCH_EXECUTION_MODE,
            executionData
        );

        assertEq(_run(d, k, u, calls), _REENTRANCY);
        assertEq(paymentToken.balanceOf(_BEEF), 0);
        assertEq(paymentToken.balanceOf(d.eoa), 10 ether);
        assertEq(paymentToken.balanceOf(address(vault)), 50 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev Intentional. One call mints 40 onto the account and sends those 40 out.
    /// The account's own balance is unchanged, so the day limit does not charge it.
    /// Was `testSameCallMintAndSendIsCharged`, which expected `ExceededSpendLimit`.
    function testIntended_SameCallMintAndSendUncharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockMintAndSendToken token = new MockMintAndSendToken();
        token.mint(d.eoa, 10 ether);
        _allow(d, k.keyHash, address(token), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(token), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(token);
        calls[0].data = abi.encodeWithSignature("syncAndSend(address,uint256)", _BEEF, 40 ether);

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(token.balanceOf(_BEEF), 40 ether);
        assertEq(token.balanceOf(d.eoa), 10 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev Intentional. The zap sends 50 of its own tokens in and `transferFrom`s
    /// them out through the standing allowance. The account's 10 stays. Spent 0.
    /// Was `testSameCallZapPassThroughIsCharged`, which expected `ExceededSpendLimit`
    /// and expected the zap's balance to stay 50.
    function testIntended_ZapPassThroughUncharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockPassThroughZap zap = new MockPassThroughZap();
        paymentToken.mint(d.eoa, 10 ether);
        paymentToken.mint(address(zap), 50 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(zap), type(uint256).max);
        _allow(d, k.keyHash, address(zap), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(zap);
        calls[0].data = abi.encodeWithSignature(
            "passThrough(address,address,uint256)",
            address(paymentToken),
            _BEEF,
            50 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(_BEEF), 50 ether);
        assertEq(paymentToken.balanceOf(d.eoa), 10 ether);
        assertEq(paymentToken.balanceOf(address(zap)), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev A deposit from the call target that stays in the account is not spend.
    function testCallTargetDepositIsNotSpend() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockPassThroughZap zap = new MockPassThroughZap();
        paymentToken.mint(address(zap), 5 ether);
        _allow(d, k.keyHash, address(zap), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(zap);
        calls[0].data = abi.encodeWithSignature(
            "deposit(address,uint256)",
            address(paymentToken),
            5 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(d.eoa), 5 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev A minute limit of 5 ether rejects an unrecognized pull of 6. The account stays.
    function testMinuteLimitRejectsPullOfSix() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        paymentToken.mint(d.eoa, 50 ether);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Minute, 5 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(paymentToken);
        calls[0].data = abi.encodeWithSignature(
            "anotherTransfer(address,uint256)",
            _BEEF,
            6 ether
        );

        assertEq(_run(d, k, u, calls), GuardedExecutor.ExceededSpendLimit.selector);
        assertEq(paymentToken.balanceOf(d.eoa), 50 ether);
        assertEq(paymentToken.balanceOf(_BEEF), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev The same minute limit charges a pull of 5.
    function testMinuteLimitChargesPullOfFive() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        paymentToken.mint(d.eoa, 50 ether);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Minute, 5 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(paymentToken);
        calls[0].data = abi.encodeWithSignature(
            "anotherTransfer(address,uint256)",
            _BEEF,
            5 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(d.eoa), 45 ether);
        assertEq(paymentToken.balanceOf(_BEEF), 5 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 5 ether);
    }

    /// @dev Intentional. The router withdraws a vault, then pays the attacker.
    /// The account's liquid balance stays 10. No ERC-20 allowance from the account.
    function testIntended_VaultForwardUncharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockVault vault = new MockVault(address(paymentToken));
        MockForwardRouter router = new MockForwardRouter();
        paymentToken.mint(d.eoa, 10 ether);
        paymentToken.mint(address(vault), 50 ether);
        _allow(d, k.keyHash, address(router), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(router);
        calls[0].data = abi.encodeWithSignature(
            "forward(address,address,address,uint256)",
            address(vault),
            address(paymentToken),
            _BEEF,
            50 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(d.eoa), 10 ether);
        assertEq(paymentToken.balanceOf(_BEEF), 50 ether);
        assertEq(paymentToken.balanceOf(address(vault)), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev Intentional. Root approved the router. A payer credits the account and the
    /// router pulls the same amount. The account's 10 stays. Spent 0.
    function testIntended_CreditThenPullUncharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockCreditThenPull router = new MockCreditThenPull();
        address payer = address(0xCAFE);
        paymentToken.mint(d.eoa, 10 ether);
        paymentToken.mint(payer, 50 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(router), type(uint256).max);
        vm.prank(payer);
        paymentToken.approve(address(router), type(uint256).max);
        _allow(d, k.keyHash, address(router), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(router);
        calls[0].data = abi.encodeWithSignature(
            "run(address,address,address,uint256)",
            address(paymentToken),
            payer,
            _BEEF,
            50 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(d.eoa), 10 ether);
        assertEq(paymentToken.balanceOf(_BEEF), 50 ether);
        assertEq(paymentToken.balanceOf(payer), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev Intentional. The router spends its own 50. A donor replaces them on the
    /// account in the same call. The account rises from 10 to 60. Spent 0.
    function testIntended_DonorTopUpLeavesTargetDropUncharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockDonorRouter router = new MockDonorRouter();
        address donor = address(0xD0E0);
        paymentToken.mint(d.eoa, 10 ether);
        paymentToken.mint(address(router), 50 ether);
        paymentToken.mint(donor, 50 ether);
        vm.prank(donor);
        paymentToken.approve(address(router), type(uint256).max);
        _allow(d, k.keyHash, address(router), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(router);
        calls[0].data = abi.encodeWithSignature(
            "sendOwnAndTakeDonation(address,address,address,uint256)",
            address(paymentToken),
            _BEEF,
            donor,
            50 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(d.eoa), 60 ether);
        assertEq(paymentToken.balanceOf(_BEEF), 50 ether);
        assertEq(paymentToken.balanceOf(address(router)), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev Intentional. An in-batch EIP-2612 permit of 8 ether leaves the allowance,
    /// and a later pull of a token with no period is not charged.
    function testIntended_Eip2612PermitLeavesUnchargedPull() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockHardcodedPuller puller = new MockHardcodedPuller(address(paymentToken));
        paymentToken.mint(d.eoa, 8 ether);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        _allow(d, k.keyHash, address(puller), _ANY_FN_SEL);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0] = _permitCall(d, address(puller), 8 ether);
        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.allowance(d.eoa, address(puller)), 8 ether);

        calls[0].to = address(puller);
        calls[0].data = abi.encodeWithSignature(
            "pull(address,address,uint256)",
            d.eoa,
            _BEEF,
            8 ether
        );
        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(_BEEF), 8 ether);
        assertEq(paymentToken.balanceOf(d.eoa), 0);
        // `transferFrom` spends the allowance. The guard did not clear it; the pull did.
        assertEq(paymentToken.allowance(d.eoa, address(puller)), 0);
        assertEq(d.d.spendInfos(k.keyHash).length, 0);
    }

    /// @dev The same permit sticks. The later pull of 8 ether against a 1 ether day
    /// limit reverts `ExceededSpendLimit`. The allowance is still 8 ether.
    function testEip2612PermitPullOverDayLimitReverts() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockHardcodedPuller puller = new MockHardcodedPuller(address(paymentToken));
        paymentToken.mint(d.eoa, 8 ether);
        _allow(d, k.keyHash, address(paymentToken), _ANY_FN_SEL);
        _allow(d, k.keyHash, address(puller), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0] = _permitCall(d, address(puller), 8 ether);
        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.allowance(d.eoa, address(puller)), 8 ether);

        calls[0].to = address(puller);
        calls[0].data = abi.encodeWithSignature(
            "pull(address,address,uint256)",
            d.eoa,
            _BEEF,
            8 ether
        );
        assertEq(_run(d, k, u, calls), GuardedExecutor.ExceededSpendLimit.selector);
        assertEq(paymentToken.balanceOf(_BEEF), 0);
        assertEq(paymentToken.balanceOf(d.eoa), 8 ether);
        assertEq(paymentToken.allowance(d.eoa, address(puller)), 8 ether);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev Intentional. A constant 32-byte `balanceOf` on a period token charges 0.
    function testIntended_LyingBalanceOfChargesZero() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockLyingBalanceToken token = new MockLyingBalanceToken();
        token.mint(d.eoa, 25 ether);
        _allow(d, k.keyHash, address(token), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(token), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(token);
        calls[0].data = abi.encodeWithSignature(
            "anotherTransfer(address,uint256)",
            _BEEF,
            25 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(token.realBalance(_BEEF), 25 ether);
        assertEq(token.realBalance(d.eoa), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev Intentional. `move` pins `balanceOf` to the pre-transfer balance, so the
    /// period token charges 0.
    function testIntended_PinnedBalanceOfChargesZero() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockPinnedBalanceToken token = new MockPinnedBalanceToken();
        token.mint(d.eoa, 25 ether);
        _allow(d, k.keyHash, address(token), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(token), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(token);
        calls[0].data = abi.encodeWithSignature("move(address,uint256)", _BEEF, 25 ether);

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(token.realBalance(_BEEF), 25 ether);
        assertEq(token.realBalance(d.eoa), 0);
        assertEq(d.d.spendInfos(k.keyHash)[0].spent, 0);
    }

    /// @dev Intentional. A non-standard approval selector sticks, and the later pull of
    /// a token with no period is not charged.
    function testIntended_CustomApproveLeavesUnchargedPull() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockCustomApproveToken token = new MockCustomApproveToken();
        MockHardcodedPuller puller = new MockHardcodedPuller(address(token));
        token.mint(d.eoa, 9 ether);
        _allow(d, k.keyHash, address(token), _ANY_FN_SEL);
        _allow(d, k.keyHash, address(puller), _ANY_FN_SEL);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(token);
        calls[0].data = abi.encodeWithSignature(
            "customApprove(address,uint256)",
            address(puller),
            9 ether
        );
        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(token.allowance(d.eoa, address(puller)), 9 ether);

        calls[0].to = address(puller);
        calls[0].data = abi.encodeWithSignature(
            "pull(address,address,uint256)",
            d.eoa,
            _BEEF,
            9 ether
        );
        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(token.balanceOf(_BEEF), 9 ether);
        assertEq(token.balanceOf(d.eoa), 0);
        assertEq(d.d.spendInfos(k.keyHash).length, 0);
    }

    /// @dev Intentional. Token A is metered. The same call pulls unperioded token B.
    function testIntended_CallToTokenAPullsUnperiodedTokenB() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockHookedToken tokenA = new MockHookedToken();
        MockPaymentToken tokenB = new MockPaymentToken();
        tokenA.mint(d.eoa, 10 ether);
        tokenB.mint(d.eoa, 6 ether);
        vm.prank(d.eoa);
        tokenB.approve(address(tokenA), type(uint256).max);
        _allow(d, k.keyHash, address(tokenA), _ANY_FN_SEL);
        _limit(d, k.keyHash, address(tokenA), GuardedExecutor.SpendPeriod.Day, 100 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(tokenA);
        calls[0].data = abi.encodeWithSignature(
            "hookedTransfer(address,address,uint256,uint256)",
            address(tokenB),
            _BEEF,
            1 ether,
            6 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(tokenA.balanceOf(_BEEF), 1 ether);
        assertEq(tokenB.balanceOf(_BEEF), 6 ether);
        assertEq(tokenB.balanceOf(d.eoa), 0);
        GuardedExecutor.SpendInfo[] memory infos = d.d.spendInfos(k.keyHash);
        assertEq(infos.length, 1);
        assertEq(infos[0].token, address(tokenA));
        assertEq(infos[0].spent, 1 ether);
    }

    /// @dev Intentional. Three escrow items, only the last non-zero, no period.
    function testIntended_ThreeItemEscrowUnperiodedTokenUncharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        Escrow escrow = new Escrow();
        paymentToken.mint(d.eoa, 50 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(escrow), type(uint256).max);
        _allow(d, k.keyHash, address(escrow), _ANY_FN_SEL);

        IEscrow.Escrow[] memory items = new IEscrow.Escrow[](3);
        items[0] = _escrowItem(bytes12(uint96(1)), d.eoa, _BEEF, 0, 0, block.timestamp + 1 days);
        items[1] = _escrowItem(bytes12(uint96(2)), d.eoa, _BEEF, 0, 0, block.timestamp + 1 days);
        items[2] = _escrowItem(
            bytes12(uint96(3)),
            d.eoa,
            _BEEF,
            50 ether,
            0,
            block.timestamp + 1 days
        );
        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(escrow);
        calls[0].data = abi.encodeCall(escrow.escrow, (items));

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(d.eoa), 0);
        assertEq(paymentToken.balanceOf(address(escrow)), 50 ether);
        assertEq(d.d.spendInfos(k.keyHash).length, 0);
    }

    /// @dev Intentional. The token word sits after a 32-word pad. No period, so no charge.
    function testIntended_Word32PullerUnperiodedTokenUncharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockWord32Puller puller = new MockWord32Puller();
        paymentToken.mint(d.eoa, 10 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(puller), type(uint256).max);
        _allow(d, k.keyHash, address(puller), _ANY_FN_SEL);

        uint256[32] memory pad;
        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(puller);
        calls[0].data = abi.encodeWithSignature(
            "pull(uint256[32],address,address,address,uint256)",
            pad,
            address(paymentToken),
            d.eoa,
            _BEEF,
            10 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(_BEEF), 10 ether);
        assertEq(paymentToken.balanceOf(d.eoa), 0);
        assertEq(d.d.spendInfos(k.keyHash).length, 0);
    }

    /// @dev Intentional. The token word has bit 160 set. No period, so no charge.
    function testIntended_Bit160PullerUnperiodedTokenUncharged() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockBit160Puller puller = new MockBit160Puller();
        paymentToken.mint(d.eoa, 10 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(puller), type(uint256).max);
        _allow(d, k.keyHash, address(puller), _ANY_FN_SEL);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(puller);
        calls[0].data = abi.encodeWithSignature(
            "pull(uint256,address,address,uint256)",
            uint256(uint160(address(paymentToken))) | (1 << 160),
            d.eoa,
            _BEEF,
            10 ether
        );

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(paymentToken.balanceOf(_BEEF), 10 ether);
        assertEq(paymentToken.balanceOf(d.eoa), 0);
        assertEq(d.d.spendInfos(k.keyHash).length, 0);
    }

    /// @dev Intentional. The trailing `safeApprove(token, spender, 0)` runs after the
    /// per-call snapshot. A token that transfers inside `approve(0)` moves its whole
    /// balance then, and the charge stays at the non-zero approve amount.
    function testIntended_ApproveZeroResetMovesHostileBalance() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        MockApproveZeroSteals token = new MockApproveZeroSteals();
        token.mint(d.eoa, 50 ether);
        _allow(d, k.keyHash, address(token), token.approve.selector);
        _limit(d, k.keyHash, address(token), GuardedExecutor.SpendPeriod.Day, 1 ether);

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(token);
        calls[0].data = abi.encodeCall(token.approve, (_BEEF, 1 ether));

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(token.balanceOf(d.eoa), 0);
        assertEq(token.balanceOf(_BEEF), 50 ether);
        assertEq(token.allowance(d.eoa, _BEEF), 0);
        GuardedExecutor.SpendInfo[] memory infos = d.d.spendInfos(k.keyHash);
        assertEq(infos.length, 1);
        assertEq(infos[0].token, address(token));
        assertEq(infos[0].spent, 1 ether);
    }

    /// @dev Intentional. A narrow key with only `Escrow.escrow`, and no `ANY_FN_SEL`,
    /// drains an unperioded token that already has a standing Escrow allowance.
    /// The metered token is untouched, so its spent stays 0.
    function testIntended_NarrowEscrowDrainsUnperiodedToken() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        Escrow escrow = new Escrow();
        MockPaymentToken unperioded = new MockPaymentToken();
        unperioded.mint(d.eoa, 50 ether);
        vm.prank(d.eoa);
        unperioded.approve(address(escrow), type(uint256).max);
        _allow(d, k.keyHash, address(escrow), escrow.escrow.selector);
        _limit(d, k.keyHash, address(paymentToken), GuardedExecutor.SpendPeriod.Day, 100 ether);

        IEscrow.Escrow[] memory items = new IEscrow.Escrow[](1);
        items[0] = IEscrow.Escrow({
            salt: bytes12(uint96(1)),
            depositor: d.eoa,
            recipient: _BEEF,
            token: address(unperioded),
            escrowAmount: 50 ether,
            refundAmount: 0,
            refundTimestamp: block.timestamp + 1 days,
            settler: address(0x1111),
            sender: address(0x2222),
            settlementId: bytes32(uint256(1)),
            senderChainId: block.chainid
        });
        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = address(escrow);
        calls[0].data = abi.encodeCall(escrow.escrow, (items));

        assertEq(_run(d, k, u, calls), bytes4(0));
        assertEq(unperioded.balanceOf(d.eoa), 0);
        assertEq(unperioded.balanceOf(address(escrow)), 50 ether);
        GuardedExecutor.SpendInfo[] memory infos = d.d.spendInfos(k.keyHash);
        assertEq(infos.length, 1);
        assertEq(infos[0].token, address(paymentToken));
        assertEq(infos[0].spent, 0);
    }

    function _session(
        bool superAdmin
    ) internal returns (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) {
        d = _randomEIP7702DelegatedEOA();
        k = _randomSecp256k1PassKey();
        k.k.isSuperAdmin = superAdmin;
        vm.prank(d.eoa);
        d.d.authorize(k.k);
        u.eoa = d.eoa;
        u.combinedGas = 10_000_000;
    }

    function _allow(DelegatedEOA memory d, bytes32 keyHash, address target, bytes4 fnSel) internal {
        vm.prank(d.eoa);
        d.d.setCanExecute(keyHash, target, fnSel, true);
    }

    function _limit(
        DelegatedEOA memory d,
        bytes32 keyHash,
        address token,
        GuardedExecutor.SpendPeriod period,
        uint256 amount
    ) internal {
        vm.prank(d.eoa);
        d.d.setSpendLimit(keyHash, token, period, amount);
    }

    function _run(
        DelegatedEOA memory d,
        PassKey memory k,
        Orchestrator.Intent memory u,
        ERC7821.Call[] memory calls
    ) internal returns (bytes4) {
        u.nonce = d.d.getNonce(0);
        u.executionData = abi.encode(calls);
        u.signature = _sig(k, u);
        return oc.execute(abi.encode(u));
    }

    function _permitCall(
        DelegatedEOA memory d,
        address spender,
        uint256 value
    ) internal view returns (ERC7821.Call memory call) {
        uint256 deadline = block.timestamp + 1 days;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                d.eoa,
                spender,
                value,
                paymentToken.nonces(d.eoa),
                deadline
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", paymentToken.DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(d.privateKey, digest);
        call.to = address(paymentToken);
        call.data = abi.encodeWithSignature(
            "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
            d.eoa,
            spender,
            value,
            deadline,
            v,
            r,
            s
        );
    }

    function _increaseCall(
        string memory signature,
        uint256 amount
    ) internal view returns (ERC7821.Call[] memory calls) {
        calls = new ERC7821.Call[](1);
        calls[0].to = address(paymentToken);
        calls[0].data = abi.encodeWithSignature(signature, _BEEF, amount);
    }

    function _escrowItem(
        bytes12 salt,
        address depositor,
        address recipient,
        uint256 escrowAmount,
        uint256 refundAmount,
        uint256 refundTimestamp
    ) internal view returns (IEscrow.Escrow memory) {
        return
            IEscrow.Escrow({
                salt: salt,
                depositor: depositor,
                recipient: recipient,
                token: address(paymentToken),
                escrowAmount: escrowAmount,
                refundAmount: refundAmount,
                refundTimestamp: refundTimestamp,
                settler: address(0x1111),
                sender: address(0x2222),
                settlementId: bytes32(uint256(1)),
                senderChainId: block.chainid
            });
    }

    function _escrowCall(
        Escrow escrow,
        address depositor,
        uint256 amount
    ) internal view returns (ERC7821.Call[] memory calls) {
        IEscrow.Escrow[] memory items = new IEscrow.Escrow[](1);
        items[0] = IEscrow.Escrow({
            salt: bytes12(uint96(1)),
            depositor: depositor,
            recipient: _BEEF,
            token: address(paymentToken),
            escrowAmount: amount,
            refundAmount: 0,
            refundTimestamp: block.timestamp + 1 days,
            settler: address(0x1111),
            sender: address(0x2222),
            settlementId: bytes32(uint256(1)),
            senderChainId: block.chainid
        });
        calls = new ERC7821.Call[](1);
        calls[0].to = address(escrow);
        calls[0].data = abi.encodeCall(escrow.escrow, (items));
    }

    function _assertBeefCannotPull(address from, uint256 amount) internal {
        vm.prank(_BEEF);
        vm.expectRevert();
        paymentToken.transferFrom(from, _BEEF, amount);
    }
}

contract YesCallChecker {
    function canExecute(bytes32, address, bytes calldata) external pure returns (bool) {
        return true;
    }
}

contract MockHardcodedPuller {
    address public immutable token;

    constructor(address token_) {
        token = token_;
    }

    function pull(address from, address to, uint256 amount) external {
        SafeTransferLib.safeTransferFrom(token, from, to, amount);
    }
}

contract MockVault {
    address public immutable token;

    constructor(address token_) {
        token = token_;
    }

    function withdraw(uint256 amount) external {
        SafeTransferLib.safeTransfer(token, msg.sender, amount);
    }
}

contract MockYieldToken is MockPaymentToken {
    function sync(uint256 amount) external {
        mint(msg.sender, amount);
    }
}

contract MockFeeOnTransferToken is MockPaymentToken {
    uint256 public fee;

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (fee != 0) _burn(msg.sender, fee);
        return super.transfer(to, amount);
    }
}

contract MockBrokenBalanceToken is MockPaymentToken {
    /// @dev 0 = normal, 1 = revert, 2 = one-byte return.
    uint8 public mode;

    function setMode(uint8 mode_) external {
        mode = mode_;
    }

    function balanceOf(address owner) public view override returns (uint256 result) {
        if (mode == 1) revert("nope");
        if (mode == 2) {
            /// @solidity memory-safe-assembly
            assembly {
                mstore(0x00, 0x01)
                return(0x00, 0x01)
            }
        }
        return super.balanceOf(owner);
    }
}

interface INestedExecute {
    function execute(bytes32 mode, bytes calldata executionData) external payable;
}

contract MockReentrantRouter {
    function attack(
        address account,
        address token,
        address to,
        uint256 amount,
        bytes32 mode,
        bytes calldata executionData
    ) external {
        INestedExecute(account).execute(mode, executionData);
        SafeTransferLib.safeTransferFrom(token, msg.sender, to, amount);
    }
}

contract MockMintAndSendToken is MockPaymentToken {
    function syncAndSend(address to, uint256 amount) external {
        mint(msg.sender, amount);
        anotherTransfer(to, amount);
    }
}

contract MockForwardRouter {
    function forward(address vault, address token, address to, uint256 amount) external {
        MockVault(vault).withdraw(amount);
        SafeTransferLib.safeTransfer(token, to, amount);
    }
}

contract MockCreditThenPull {
    function run(address token, address payer, address to, uint256 amount) external {
        SafeTransferLib.safeTransferFrom(token, payer, msg.sender, amount);
        SafeTransferLib.safeTransferFrom(token, msg.sender, to, amount);
    }
}

contract MockDonorRouter {
    function sendOwnAndTakeDonation(
        address token,
        address to,
        address donor,
        uint256 amount
    ) external {
        SafeTransferLib.safeTransfer(token, to, amount);
        SafeTransferLib.safeTransferFrom(token, donor, msg.sender, amount);
    }
}

contract MockPassThroughZap {
    function passThrough(address token, address to, uint256 amount) external {
        SafeTransferLib.safeTransfer(token, msg.sender, amount);
        SafeTransferLib.safeTransferFrom(token, msg.sender, to, amount);
    }

    function deposit(address token, uint256 amount) external {
        SafeTransferLib.safeTransfer(token, msg.sender, amount);
    }
}

contract MockLyingBalanceToken is MockPaymentToken {
    function balanceOf(address) public view override returns (uint256) {
        return 1_000_000 ether;
    }

    function realBalance(address owner) public view returns (uint256) {
        return super.balanceOf(owner);
    }
}

contract MockPinnedBalanceToken is MockPaymentToken {
    uint256 internal pinned;
    address internal pinnedOwner;
    bool internal pinning;

    function balanceOf(address owner) public view override returns (uint256) {
        if (pinning && owner == pinnedOwner) return pinned;
        return super.balanceOf(owner);
    }

    function move(address to, uint256 amount) external {
        if (!pinning) {
            pinnedOwner = msg.sender;
            pinned = super.balanceOf(msg.sender);
            pinning = true;
        }
        anotherTransfer(to, amount);
    }

    function realBalance(address owner) public view returns (uint256) {
        return super.balanceOf(owner);
    }
}

contract MockCustomApproveToken is MockPaymentToken {
    function customApprove(address spender, uint256 amount) external returns (bool) {
        return approve(spender, amount);
    }
}

/// @dev `approve(0)` transfers the caller's whole balance to `spender`, then sets the allowance.
contract MockApproveZeroSteals is MockPaymentToken {
    function approve(address spender, uint256 amount) public override returns (bool) {
        if (amount == 0) {
            uint256 bal = balanceOf(msg.sender);
            if (bal != 0) transfer(spender, bal);
        }
        return super.approve(spender, amount);
    }
}

contract MockHookedToken is MockPaymentToken {
    function hookedTransfer(
        address other,
        address to,
        uint256 amount,
        uint256 otherAmount
    ) external {
        anotherTransfer(to, amount);
        SafeTransferLib.safeTransferFrom(other, msg.sender, to, otherAmount);
    }
}

contract MockWord32Puller {
    function pull(
        uint256[32] calldata,
        address token,
        address from,
        address to,
        uint256 amount
    ) external {
        SafeTransferLib.safeTransferFrom(token, from, to, amount);
    }
}

contract MockBit160Puller {
    function pull(uint256 tokenWord, address from, address to, uint256 amount) external {
        SafeTransferLib.safeTransferFrom(address(uint160(tokenWord)), from, to, amount);
    }
}
