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

    /// @dev Checker that authorizes every call. Spend limits still apply.
    YesCallChecker internal yesChecker;

    function setUp() public virtual override {
        super.setUp();
        yesChecker = new YesCallChecker();
        assertEq(MockPaymentToken.increaseAllowance.selector, bytes4(0x39509351));
        assertEq(MockPaymentToken.increaseApproval.selector, bytes4(0xd73dd623));
    }

    function testUntrackedSelectorBypassesSpendWhitelist() public {
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

        assertEq(_run(d, k, u, calls), bytes4(keccak256("NoSpendPermissions()")));
        assertEq(paymentToken.balanceOf(d.eoa), 50 ether);
        assertEq(paymentToken.balanceOf(_BEEF), 0);
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

    function testEscrowPullWithPreexistingAllowanceAndNoLimit() public {
        (DelegatedEOA memory d, PassKey memory k, Orchestrator.Intent memory u) = _session(false);
        Escrow escrow = new Escrow();
        paymentToken.mint(d.eoa, 50 ether);
        vm.prank(d.eoa);
        paymentToken.approve(address(escrow), type(uint256).max);
        _allow(d, k.keyHash, address(escrow), _ANY_FN_SEL);

        assertEq(
            _run(d, k, u, _escrowCall(escrow, d.eoa, 50 ether)),
            bytes4(keccak256("NoSpendPermissions()"))
        );
        assertEq(paymentToken.balanceOf(d.eoa), 50 ether);
        assertEq(paymentToken.balanceOf(address(escrow)), 0);
    }

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

    /// @dev Documented residual: the token address is not in calldata and has no spend period.
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
