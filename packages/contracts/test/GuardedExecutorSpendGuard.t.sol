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
