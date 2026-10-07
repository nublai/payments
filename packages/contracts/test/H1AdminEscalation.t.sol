// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "./Base.t.sol";
import "./utils/mocks/MockCallChecker.sol";

/// @dev Regression for H1: a non-super-admin key must not be able to install a
/// permanent super admin, or call any other onlyThis admin selector, by holding
/// `ANY_TARGET` / `ANY_FN_SEL` or an explicit admin selector.
contract H1AdminEscalationTest is BaseTest {
    bytes4 internal constant _UNAUTHORIZED_CALL =
        bytes4(keccak256("UnauthorizedCall(bytes32,address,bytes)"));

    function testSessionKeyWithWildcardCallsCannotInstallSuperAdmin() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        PassKey memory session = _randomSecp256k1PassKey();
        session.k.expiry = uint40(block.timestamp + 1 days);
        session.k.isSuperAdmin = false;

        PassKey memory implanted = _randomSecp256k1PassKey();
        implanted.k.expiry = 0;
        implanted.k.isSuperAdmin = true;

        paymentToken.mint(d.eoa, 1000 ether);

        vm.startPrank(d.eoa);
        d.d.authorize(session.k);
        d.d.setCanExecute(session.keyHash, _ANY_TARGET, _ANY_FN_SEL, true);
        d.d.setSpendLimit(session.keyHash, address(0), GuardedExecutor.SpendPeriod.Forever, 1);
        d.d.setSpendLimit(
            session.keyHash,
            address(paymentToken),
            GuardedExecutor.SpendPeriod.Forever,
            1000 ether
        );
        vm.stopPrank();

        bytes memory authorizeData = abi.encodeWithSelector(
            AgenticAccount.authorize.selector,
            implanted.k
        );

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].data = authorizeData;

        Orchestrator.Intent memory u;
        u.eoa = d.eoa;
        u.combinedGas = 10_000_000;
        u.nonce = d.d.getNonce(0);
        u.executionData = abi.encode(calls);
        u.signature = _sig(session, u);
        assertEq(oc.execute(abi.encode(u)), _UNAUTHORIZED_CALL);
        assertFalse(d.d.canExecute(session.keyHash, address(d.d), authorizeData));
        vm.expectRevert(AgenticAccount.KeyDoesNotExist.selector);
        d.d.getKey(implanted.keyHash);

        vm.warp(block.timestamp + 2 days);
        u.nonce = d.d.getNonce(0);
        u.executionData = abi.encode(calls);
        u.signature = _sig(session, u);
        assertEq(oc.execute(abi.encode(u)), Orchestrator.VerificationError.selector);

        vm.warp(block.timestamp - 2 days);
        calls[0] = _transferCall(address(paymentToken), address(0xBEEF), 1000 ether);
        u.nonce = d.d.getNonce(0);
        u.executionData = abi.encode(calls);
        u.signature = _sig(implanted, u);
        // Missing keys fail closed inside signature verification.
        assertEq(oc.execute(abi.encode(u)), Orchestrator.VerificationError.selector);
        assertEq(paymentToken.balanceOf(address(0xBEEF)), 0);

        // The same wildcard still reaches a non-admin call within the spend limit.
        calls[0] = _transferCall(address(paymentToken), address(0xBEEF), 1 ether);
        u.nonce = d.d.getNonce(0);
        u.executionData = abi.encode(calls);
        u.signature = _sig(session, u);
        assertEq(oc.execute(abi.encode(u)), bytes4(0));
        assertEq(paymentToken.balanceOf(address(0xBEEF)), 1 ether);
    }

    function testNonSuperAdminCannotBeGrantedOrExerciseAdminSelectors() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        PassKey memory session = _randomSecp256k1PassKey();
        session.k.isSuperAdmin = false;

        vm.startPrank(d.eoa);
        d.d.authorize(session.k);

        bytes4[] memory selectors = _adminSelectors();
        for (uint256 i; i < selectors.length; ++i) {
            vm.expectRevert(GuardedExecutor.CannotSelfExecute.selector);
            d.d.setCanExecute(session.keyHash, address(d.d), selectors[i], true);
            vm.expectRevert(GuardedExecutor.CannotSelfExecute.selector);
            d.d.setCanExecute(session.keyHash, _ANY_TARGET, selectors[i], true);
        }
        vm.expectRevert(GuardedExecutor.CannotSelfExecute.selector);
        d.d.setCanExecute(session.keyHash, address(d.d), _ANY_FN_SEL, true);

        d.d.setCanExecute(session.keyHash, _ANY_TARGET, _ANY_FN_SEL, true);
        vm.stopPrank();

        for (uint256 i; i < selectors.length; ++i) {
            assertFalse(
                d.d.canExecute(session.keyHash, address(d.d), abi.encodePacked(selectors[i]))
            );
        }
        assertTrue(
            d.d.canExecute(
                session.keyHash,
                address(paymentToken),
                abi.encodeWithSignature("transfer(address,uint256)", address(0xBEEF), uint256(1))
            )
        );

        // address(0) is coalesced to the account inside execute. The view does not coalesce.
        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].data = abi.encodeWithSelector(AgenticAccount.revoke.selector, session.keyHash);
        Orchestrator.Intent memory u = _intent(d, calls, session);
        assertEq(oc.execute(abi.encode(u)), _UNAUTHORIZED_CALL);
        assertEq(d.d.getKey(session.keyHash).expiry, session.k.expiry);

        calls[0].data = abi.encodeWithSelector(
            GuardedExecutor.setSpendLimit.selector,
            session.keyHash,
            address(0),
            GuardedExecutor.SpendPeriod.Forever,
            uint256(0)
        );
        u = _intent(d, calls, session);
        assertEq(oc.execute(abi.encode(u)), _UNAUTHORIZED_CALL);

        calls[0].data = abi.encodeWithSelector(
            AgenticAccount.upgradeProxyAccount.selector,
            address(0xBEEF)
        );
        u = _intent(d, calls, session);
        assertEq(oc.execute(abi.encode(u)), _UNAUTHORIZED_CALL);
    }

    function testCallCheckerCannotUnlockAdminSelectors() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        PassKey memory session = _randomSecp256k1PassKey();
        session.k.isSuperAdmin = false;

        bytes memory authorizeData = abi.encodeWithSelector(
            AgenticAccount.authorize.selector,
            session.k
        );
        MockCallChecker checker = new MockCallChecker();
        checker.setAuthorized(session.keyHash, address(d.d), authorizeData);

        vm.startPrank(d.eoa);
        d.d.authorize(session.k);
        d.d.setCallChecker(session.keyHash, _ANY_TARGET, address(checker));
        vm.stopPrank();

        assertFalse(d.d.canExecute(session.keyHash, address(d.d), authorizeData));

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].data = authorizeData;
        assertEq(oc.execute(abi.encode(_intent(d, calls, session))), _UNAUTHORIZED_CALL);
        assertEq(d.d.keyCount(), 1);
    }

    function testSuperAdminKeyCanStillAuthorize() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        PassKey memory admin = _randomSecp256k1PassKey();
        admin.k.isSuperAdmin = true;
        admin.k.expiry = 0;

        PassKey memory created = _randomSecp256k1PassKey();
        created.k.isSuperAdmin = false;
        created.k.expiry = uint40(block.timestamp + 1 days);

        vm.prank(d.eoa);
        d.d.authorize(admin.k);

        bytes memory authorizeData = abi.encodeWithSelector(
            AgenticAccount.authorize.selector,
            created.k
        );
        assertTrue(d.d.canExecute(admin.keyHash, address(d.d), authorizeData));

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].data = authorizeData;
        assertEq(oc.execute(abi.encode(_intent(d, calls, admin))), bytes4(0));

        AgenticAccount.Key memory stored = d.d.getKey(created.keyHash);
        assertEq(stored.expiry, created.k.expiry);
        assertFalse(stored.isSuperAdmin);
        assertEq(d.d.keyCount(), 2);
    }

    function _intent(
        DelegatedEOA memory d,
        ERC7821.Call[] memory calls,
        PassKey memory signer
    ) internal view returns (Orchestrator.Intent memory u) {
        u.eoa = d.eoa;
        u.combinedGas = 10_000_000;
        u.nonce = d.d.getNonce(0);
        u.executionData = abi.encode(calls);
        u.signature = _sig(signer, u);
    }

    function _adminSelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](12);
        selectors[0] = ERC7821.execute.selector;
        selectors[1] = GuardedExecutor.setCanExecute.selector;
        selectors[2] = GuardedExecutor.setCallChecker.selector;
        selectors[3] = GuardedExecutor.setSpendLimit.selector;
        selectors[4] = GuardedExecutor.removeSpendLimit.selector;
        selectors[5] = AgenticAccount.authorize.selector;
        selectors[6] = AgenticAccount.revoke.selector;
        selectors[7] = AgenticAccount.setLabel.selector;
        selectors[8] = AgenticAccount.setSignatureCheckerApproval.selector;
        selectors[9] = AgenticAccount.invalidateNonce.selector;
        selectors[10] = AgenticAccount.upgradeProxyAccount.selector;
        selectors[11] = AgenticAccount.upgradeHook.selector;
    }
}
