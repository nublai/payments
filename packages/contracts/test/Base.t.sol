// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import {GuardedExecutor} from "../src/accounts/GuardedExecutor.sol";
import "./utils/SoladyTest.sol";
import {MockAccount, TownsAccount} from "./utils/mocks/MockAccount.sol";
import {MockOrchestrator, Orchestrator} from "./utils/mocks/MockOrchestrator.sol";
import {ERC20, MockPaymentToken} from "./utils/mocks/MockPaymentToken.sol";
import {EIP7702Proxy} from "solady/accounts/EIP7702Proxy.sol";
import {ERC7821} from "solady/accounts/ERC7821.sol";
import {LibEIP7702} from "solady/accounts/LibEIP7702.sol";
import {LibERC7579} from "solady/accounts/LibERC7579.sol";
import {EfficientHashLib} from "solady/utils/EfficientHashLib.sol";
import {FixedPointMathLib as Math} from "solady/utils/FixedPointMathLib.sol";
import {GasBurnerLib} from "solady/utils/GasBurnerLib.sol";
import {LibBytes} from "solady/utils/LibBytes.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {LibRLP} from "solady/utils/LibRLP.sol";
import {LibSort} from "solady/utils/LibSort.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {Simulator} from "../src/accounts/Simulator.sol";
import {ICommon} from "../src/accounts/interfaces/ICommon.sol";
import {IOrchestrator} from "../src/accounts/interfaces/IOrchestrator.sol";

contract BaseTest is SoladyTest {
    using LibRLP for LibRLP.List;

    MockOrchestrator oc;
    MockPaymentToken paymentToken;
    address accountImplementation;
    MockAccount account;
    EIP7702Proxy eip7702Proxy;
    TargetFunctionPayload[] targetFunctionPayloads;
    Simulator simulator;
    bytes32 contextKeyHash;

    struct TargetFunctionPayload {
        address by;
        uint256 value;
        bytes data;
    }

    bytes32 internal constant _ANY_KEYHASH =
        0x3232323232323232323232323232323232323232323232323232323232323232;

    address internal constant _ANY_TARGET = 0x3232323232323232323232323232323232323232;

    bytes4 internal constant _ANY_FN_SEL = 0x32323232;

    bytes4 internal constant _EMPTY_CALLDATA_FN_SEL = 0xe0e0e0e0;

    address internal constant _PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 internal constant _ERC7821_BATCH_EXECUTION_MODE =
        0x0100000000007821000100000000000000000000000000000000000000000000;

    bytes32 internal constant _ERC7579_DELEGATE_CALL_MODE =
        0xff00000000000000000000000000000000000000000000000000000000000000;

    address internal constant _ORIGIN_ADDRESS = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    struct PassKey {
        TownsAccount.Key k;
        uint256 privateKey;
        bytes32 keyHash;
    }

    struct MultiSigKey {
        TownsAccount.Key k;
        uint256 threshold;
        PassKey[] owners;
    }

    struct DelegatedEOA {
        address eoa;
        uint256 privateKey;
        MockAccount d;
    }

    function setUp() public virtual {
        oc = new MockOrchestrator();
        paymentToken = new MockPaymentToken();
        accountImplementation = address(new MockAccount(address(oc)));
        eip7702Proxy = EIP7702Proxy(
            payable(LibEIP7702.deployProxy(accountImplementation, address(this)))
        );
        account = MockAccount(payable(eip7702Proxy));
        simulator = new Simulator();
    }

    function targetFunction(bytes memory data) public payable {
        targetFunctionPayloads.push(TargetFunctionPayload(msg.sender, msg.value, data));
    }

    function targetFunctionContextKeyHash() public payable {
        contextKeyHash = TownsAccount(payable(msg.sender)).getContextKeyHash();
    }

    function _setEIP7702Delegation(address eoa) internal {
        vm.etch(eoa, abi.encodePacked(hex"ef0100", address(account)));
    }

    function _randomEIP7702DelegatedEOA() internal returns (DelegatedEOA memory d) {
        (d.eoa, d.privateKey) = _randomUniqueSigner();
        _setEIP7702Delegation(d.eoa);
        d.d = MockAccount(payable(d.eoa));
    }

    function _hash(TownsAccount.Key memory k) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint8(k.keyType), keccak256(k.publicKey)));
    }

    function _randomPassKey() internal returns (PassKey memory) {
        return _randomSecp256k1PassKey();
    }

    function _randomSecp256k1PassKey() internal returns (PassKey memory k) {
        k.k.keyType = TownsAccount.KeyType.Secp256k1;
        address addr;
        (addr, k.privateKey) = _randomUniqueSigner();
        k.k.publicKey = abi.encode(addr);
        k.keyHash = _hash(k.k);
    }

    function _sig(
        DelegatedEOA memory d,
        Orchestrator.Intent memory i
    ) internal view returns (bytes memory) {
        return _eoaSig(d.privateKey, i);
    }

    function _sig(DelegatedEOA memory d, bytes32 digest) internal pure returns (bytes memory) {
        return _eoaSig(d.privateKey, digest);
    }

    function _eoaSig(
        uint256 privateKey,
        Orchestrator.Intent memory i
    ) internal view returns (bytes memory) {
        return _eoaSig(privateKey, oc.computeDigest(i));
    }

    function _eoaSig(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sig(
        PassKey memory k,
        Orchestrator.Intent memory i
    ) internal view returns (bytes memory) {
        return _sig(k, false, oc.computeDigest(i));
    }

    function _sig(PassKey memory k, bytes32 digest) internal pure returns (bytes memory) {
        return _sig(k, false, digest);
    }

    function _sig(
        PassKey memory k,
        bool prehash,
        bytes32 digest
    ) internal pure returns (bytes memory) {
        if (k.k.keyType == TownsAccount.KeyType.Secp256k1) {
            return _secp256k1Sig(k.privateKey, k.keyHash, prehash, digest);
        }
        revert("Unsupported");
    }

    function _sig(MultiSigKey memory k, bytes32 digest) internal pure returns (bytes memory) {
        return _multiSig(k, _hash(k.k), false, digest);
    }

    function _sig(
        MultiSigKey memory k,
        Orchestrator.Intent memory u
    ) internal view returns (bytes memory) {
        return _multiSig(k, _hash(k.k), false, oc.computeDigest(u));
    }

    function _sig(
        MultiSigKey memory k,
        bool prehash,
        bytes32 digest
    ) internal pure returns (bytes memory) {
        return _multiSig(k, _hash(k.k), prehash, digest);
    }

    function _secp256k1Sig(
        uint256 privateKey,
        bytes32 keyHash,
        bytes32 digest
    ) internal pure returns (bytes memory) {
        return _secp256k1Sig(privateKey, keyHash, false, digest);
    }

    function _secp256k1Sig(
        uint256 privateKey,
        bytes32 keyHash,
        bool prehash,
        bytes32 digest
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(abi.encodePacked(r, s, v), keyHash, uint8(prehash ? 1 : 0));
    }

    function _multiSig(
        MultiSigKey memory k,
        bytes32 keyHash,
        bool preHash,
        bytes32 digest
    ) internal pure returns (bytes memory) {
        bytes[] memory signatures = new bytes[](k.threshold);
        for (uint256 i; i < k.threshold; ++i) {
            signatures[i] = _sig(k.owners[i], digest);
        }

        return abi.encodePacked(abi.encode(signatures), keyHash, uint8(preHash ? 1 : 0));
    }

    function _estimateGasForEOAKey(
        Orchestrator.Intent memory i
    ) internal returns (uint256 gExecute, uint256 gCombined, uint256 gUsed) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            uint128(_randomUniform()),
            bytes32(_randomUniform())
        );
        i.signature = abi.encodePacked(r, s, v);
        return _estimateGas(i);
    }

    function _estimateGas(
        PassKey memory k,
        Orchestrator.Intent memory i
    ) internal returns (uint256 gExecute, uint256 gCombined, uint256 gUsed) {
        if (k.k.keyType == TownsAccount.KeyType.Secp256k1) {
            return _estimateGasForSecp256k1Key(k.keyHash, i);
        }
        revert("Unsupported");
    }

    function _estimateGasForSecp256k1Key(
        bytes32 keyHash,
        Orchestrator.Intent memory i
    ) internal returns (uint256 gExecute, uint256 gCombined, uint256 gUsed) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            uint128(_randomUniform()),
            bytes32(_randomUniform())
        );
        i.signature = abi.encodePacked(abi.encodePacked(r, s, v), keyHash, uint8(0));
        return _estimateGas(i);
    }

    function _estimateGasForMultiSigKey(
        MultiSigKey memory k,
        Orchestrator.Intent memory u
    ) internal returns (uint256 gExecute, uint256 gCombined, uint256 gUsed) {
        return
            _estimateGas(
                _EstimateGasParams({
                    u: u,
                    paymentPerGasPrecision: 0,
                    paymentPerGas: 1,
                    combinedGasIncrement: 110_000,
                    combinedGasVerificationOffset: 10_000 * k.threshold
                })
            );
    }

    function _estimateGas(
        Orchestrator.Intent memory i
    ) internal returns (uint256 gExecute, uint256 gCombined, uint256 gUsed) {
        uint256 snapshot = vm.snapshotState();
        vm.deal(_ORIGIN_ADDRESS, type(uint192).max);

        (gUsed, gCombined) = simulator.simulateV1Logs(
            address(oc),
            0,
            1,
            11_000,
            10_000,
            abi.encode(i)
        );

        // gExecute > (100k + combinedGas) * 64/63
        gExecute = Math.mulDiv(gCombined + 110_000, 64, 63);

        vm.revertToStateAndDelete(snapshot);

        gExecute = Math.mulDiv(gCombined + 110_000, 64, 63) + 30_000;
    }

    struct _EstimateGasParams {
        Orchestrator.Intent u;
        uint8 paymentPerGasPrecision;
        uint256 paymentPerGas;
        uint256 combinedGasIncrement;
        uint256 combinedGasVerificationOffset;
    }

    function _estimateGas(
        _EstimateGasParams memory p
    ) internal returns (uint256 gExecute, uint256 gCombined, uint256 gUsed) {
        {
            uint256 snapshot = vm.snapshotState();

            // Set the simulator to have max balance, so that it can run in state override mode.
            // This is meant to mimic an offchain state override.
            vm.deal(_ORIGIN_ADDRESS, type(uint192).max);

            (gUsed, gCombined) = simulator.simulateV1Logs(
                address(oc),
                p.paymentPerGasPrecision,
                p.paymentPerGas,
                p.combinedGasIncrement,
                p.combinedGasVerificationOffset,
                abi.encode(p.u)
            );
            vm.revertToStateAndDelete(snapshot);
        }

        // gExecute > (100k + combinedGas) * 64/63
        gExecute = Math.mulDiv(gCombined + 110_000, 64, 63) + 30_000;
    }

    function _mint(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            vm.deal(to, amount);
        } else {
            MockPaymentToken(token).mint(to, amount);
        }
    }

    function _balanceOf(address token, address owner) internal view returns (uint256) {
        if (token == address(0)) {
            return address(owner).balance;
        } else {
            return MockPaymentToken(token).balanceOf(owner);
        }
    }

    function _transferCall(
        address token,
        address to,
        uint256 amount
    ) internal pure returns (ERC7821.Call memory c) {
        if (token == address(0)) {
            c.to = to;
            c.value = amount;
        } else {
            c.to = token;
            c.data = abi.encodeWithSignature("transfer(address,uint256)", to, amount);
        }
    }

    function _setSpendLimitCall(
        PassKey memory k,
        address token,
        GuardedExecutor.SpendPeriod period,
        uint256 amount
    ) internal pure returns (ERC7821.Call memory c) {
        c.data = abi.encodeWithSelector(
            GuardedExecutor.setSpendLimit.selector,
            k.keyHash,
            token,
            period,
            amount
        );
    }

    function _removeSpendLimitCall(
        PassKey memory k,
        address token,
        GuardedExecutor.SpendPeriod period
    ) internal pure returns (ERC7821.Call memory c) {
        c.data = abi.encodeWithSelector(
            GuardedExecutor.removeSpendLimit.selector,
            k.keyHash,
            token,
            period
        );
    }

    function _transferExecutionData(
        address token,
        address to,
        uint256 amount
    ) internal pure returns (bytes memory) {
        return _encode(_transferCall(token, to, amount));
    }

    function _thisTargetFunctionCall(
        uint256 value,
        bytes memory data
    ) internal view returns (ERC7821.Call memory c) {
        c.to = address(this);
        c.value = value;
        c.data = abi.encodeWithSignature("targetFunction(bytes)", data);
    }

    function _thisTargetFunctionExecutionData(
        uint256 value,
        bytes memory data
    ) internal view returns (bytes memory) {
        return _encode(_thisTargetFunctionCall(value, data));
    }

    function _encode(ERC7821.Call memory c) internal pure returns (bytes memory) {
        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0] = c;
        return abi.encode(calls);
    }

    function _executionData(
        address target,
        uint256 value,
        bytes memory data
    ) internal pure returns (bytes memory) {
        ERC7821.Call memory c;
        c.to = target;
        c.value = value;
        c.data = data;
        return _encode(c);
    }

    function _executionData(
        address target,
        bytes memory data
    ) internal pure returns (bytes memory) {
        return _executionData(target, 0, data);
    }

    function _randomTarget() internal returns (address) {
        if (_randomChance(32)) return _ANY_TARGET;
        return address(uint160(_randomUniform()));
    }

    function _randomFnSel() internal returns (bytes4) {
        if (_randomChance(32)) return _ANY_FN_SEL;
        return bytes4(bytes32(_randomUniform()));
    }
}
