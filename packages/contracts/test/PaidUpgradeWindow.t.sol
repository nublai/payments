// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "./Base.t.sol";
import {Account as AgenticAccount} from "../src/accounts/Account.sol";
import {LibEIP7702} from "solady/accounts/LibEIP7702.sol";
import {EIP7702Proxy} from "solady/accounts/EIP7702Proxy.sol";

/// The window after a bare authorize and before setCanExecute / setSpendLimit.
/// Delegation target is the Account implementation, not MockAccount.
contract PaidUpgradeWindowTest is BaseTest {
    AgenticAccount internal realAccount;

    function setUp() public override {
        super.setUp();
        address implementation = address(new AgenticAccount(address(oc)));
        realAccount = AgenticAccount(payable(LibEIP7702.deployProxy(implementation, address(this))));
        eip7702Proxy = EIP7702Proxy(payable(address(realAccount)));
    }

    function testBareSessionKeyCannotMoveFunds() public {
        (address eoa, uint256 ownerKey) = _randomUniqueSigner();
        ownerKey = ownerKey;
        vm.etch(eoa, abi.encodePacked(hex"ef0100", address(realAccount)));
        AgenticAccount account = AgenticAccount(payable(eoa));

        PassKey memory k = _randomSecp256k1PassKey();
        k.k.expiry = 0;
        k.k.isSuperAdmin = false;
        assertTrue(k.keyHash != bytes32(0));

        vm.prank(eoa);
        account.authorize(k.k);

        AgenticAccount.Key memory stored = account.getKey(k.keyHash);
        assertFalse(stored.isSuperAdmin);
        assertEq(stored.expiry, 0);

        paymentToken.mint(eoa, 1 ether);

        Orchestrator.Intent memory callIntent = _intent(eoa, _balanceCall());
        callIntent.signature = _sig(k, callIntent);
        assertEq(
            oc.execute(abi.encode(callIntent)),
            bytes4(keccak256("UnauthorizedCall(bytes32,address,bytes)"))
        );
        assertEq(paymentToken.balanceOf(address(0xb0b)), 0);

        Orchestrator.Intent memory transferIntent = _intent(eoa, _transferCall(1 ether));
        transferIntent.signature = _sig(k, transferIntent);
        assertEq(
            oc.execute(abi.encode(transferIntent)),
            bytes4(keccak256("UnauthorizedCall(bytes32,address,bytes)"))
        );
        assertEq(paymentToken.balanceOf(eoa), 1 ether);

        vm.prank(eoa);
        account.setCanExecute(k.keyHash, address(paymentToken), bytes4(0xa9059cbb), true);

        Orchestrator.Intent memory unfunded = _intent(eoa, _transferCall(1 ether));
        unfunded.signature = _sig(k, unfunded);
        assertEq(oc.execute(abi.encode(unfunded)), bytes4(keccak256("NoSpendPermissions()")));
        assertEq(paymentToken.balanceOf(eoa), 1 ether);
        assertEq(paymentToken.balanceOf(address(0xb0b)), 0);
    }

    function _intent(
        address eoa,
        ERC7821.Call[] memory calls
    ) internal view returns (Orchestrator.Intent memory u) {
        AgenticAccount account = AgenticAccount(payable(eoa));
        u.eoa = eoa;
        u.combinedGas = 10_000_000;
        u.nonce = account.getNonce(0);
        u.executionData = abi.encode(calls);
    }

    function _balanceCall() internal view returns (ERC7821.Call[] memory calls) {
        calls = new ERC7821.Call[](1);
        calls[0].to = address(paymentToken);
        calls[0].data = abi.encodeWithSignature("balanceOf(address)", address(this));
    }

    function _transferCall(uint256 amount) internal view returns (ERC7821.Call[] memory calls) {
        calls = new ERC7821.Call[](1);
        calls[0].to = address(paymentToken);
        calls[0].data = abi.encodeWithSignature(
            "transfer(address,uint256)",
            address(0xb0b),
            amount
        );
    }
}
