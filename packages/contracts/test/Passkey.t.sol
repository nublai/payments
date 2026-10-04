// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "./Base.t.sol";
import {LibString} from "solady/utils/LibString.sol";

// Forge 1.8.4 only installs P256VERIFY (0x100) on Osaka, not Prague.
/// forge-config: default.hardfork = "osaka"
contract PasskeyTest is BaseTest {
    function testP256ValidSignature() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        bytes32 digest = keccak256("passkey");
        bytes memory authenticatorData = _authenticatorData(hex"01");

        (bytes memory publicKey, bytes memory clientDataJSON, uint256 r, uint256 s) =
            _signWebAuthn(digest, authenticatorData);

        AgenticAccount.Key memory key = _p256Key(publicKey);
        vm.prank(d.eoa);
        bytes32 keyHash = d.d.authorize(key);
        assertEq(uint8(AgenticAccount.KeyType.Secp256k1), 0);
        assertEq(uint8(AgenticAccount.KeyType.External), 1);
        assertEq(uint8(AgenticAccount.KeyType.P256), 2);
        assertEq(keyHash, _hash(key));

        (bool isValid, bytes32 got) =
            d.d.unwrapAndValidateSignature(digest, _wrap(authenticatorData, clientDataJSON, r, s, keyHash, 0));
        assertTrue(isValid);
        assertEq(got, keyHash);
    }

    function testP256WrongChallenge() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        bytes32 digest = keccak256("expected-challenge");
        bytes32 other = keccak256("other-challenge");
        bytes memory authenticatorData = _authenticatorData(hex"01");

        // Signature is valid for `other`, but the account digest is `digest`.
        (bytes memory publicKey, bytes memory clientDataJSON, uint256 r, uint256 s) =
            _signWebAuthn(other, authenticatorData);

        vm.prank(d.eoa);
        bytes32 keyHash = d.d.authorize(_p256Key(publicKey));

        (bool isValid, bytes32 got) =
            d.d.unwrapAndValidateSignature(digest, _wrap(authenticatorData, clientDataJSON, r, s, keyHash, 0));
        assertFalse(isValid);
        assertEq(got, keyHash);
    }

    function testP256UserPresenceFlagRequired() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        bytes32 digest = keccak256("up-flag");
        // Cryptographically valid WebAuthn assertion with the UP bit clear.
        bytes memory authenticatorData = _authenticatorData(hex"00");

        (bytes memory publicKey, bytes memory clientDataJSON, uint256 r, uint256 s) =
            _signWebAuthn(digest, authenticatorData);

        vm.prank(d.eoa);
        bytes32 keyHash = d.d.authorize(_p256Key(publicKey));

        (bool isValid, bytes32 got) =
            d.d.unwrapAndValidateSignature(digest, _wrap(authenticatorData, clientDataJSON, r, s, keyHash, 0));
        assertFalse(isValid);
        assertEq(got, keyHash);
    }

    function testP256CorruptedR() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        bytes32 digest = keccak256("corrupt-r");
        bytes memory authenticatorData = _authenticatorData(hex"05");

        (bytes memory publicKey, bytes memory clientDataJSON, uint256 r, uint256 s) =
            _signWebAuthn(digest, authenticatorData);

        vm.prank(d.eoa);
        bytes32 keyHash = d.d.authorize(_p256Key(publicKey));

        (bool isValid, bytes32 got) =
            d.d.unwrapAndValidateSignature(digest, _wrap(authenticatorData, clientDataJSON, r ^ 1, s, keyHash, 0));
        assertFalse(isValid);
        assertEq(got, keyHash);
    }

    function testSecp256k1KeyStillValidates() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        PassKey memory k = _randomSecp256k1PassKey();
        vm.prank(d.eoa);
        d.d.authorize(k.k);

        bytes32 digest = keccak256("secp256k1");
        (bool isValid, bytes32 got) = d.d.unwrapAndValidateSignature(digest, _sig(k, digest));
        assertTrue(isValid);
        assertEq(got, k.keyHash);
    }

    function testP256PrehashFlag() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        bytes32 originalDigest = keccak256("prehash-original");
        bytes32 challengeDigest = sha256(abi.encodePacked(originalDigest));
        bytes memory authenticatorData = _authenticatorData(hex"01");

        (bytes memory publicKey, bytes memory clientDataJSON, uint256 r, uint256 s) =
            _signWebAuthn(challengeDigest, authenticatorData);

        vm.prank(d.eoa);
        bytes32 keyHash = d.d.authorize(_p256Key(publicKey));

        (bool isValid, bytes32 got) =
            d.d.unwrapAndValidateSignature(originalDigest, _wrap(authenticatorData, clientDataJSON, r, s, keyHash, 1));
        assertTrue(isValid);
        assertEq(got, keyHash);
    }


    function testP256AuthenticatorDataTooShort() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        bytes32 digest = keccak256("short-auth-data");
        // One byte under the 37-byte minimum, with the UP bit set at index 32
        // so the length check is what rejects it.
        bytes memory authenticatorData = new bytes(36);
        authenticatorData[32] = 0x01;

        (bytes memory publicKey, bytes memory clientDataJSON, uint256 r, uint256 s) =
            _signWebAuthn(digest, authenticatorData);

        vm.prank(d.eoa);
        bytes32 keyHash = d.d.authorize(_p256Key(publicKey));

        (bool isValid, bytes32 got) =
            d.d.unwrapAndValidateSignature(digest, _wrap(authenticatorData, clientDataJSON, r, s, keyHash, 0));
        assertFalse(isValid);
        assertEq(got, keyHash);
    }

    function testP256WebAuthnRejectedForSecp256k1Key() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        bytes32 digest = keccak256("p256-as-secp256k1");
        bytes memory authenticatorData = _authenticatorData(hex"01");

        (bytes memory publicKey, bytes memory clientDataJSON, uint256 r, uint256 s) =
            _signWebAuthn(digest, authenticatorData);

        PassKey memory k = _randomSecp256k1PassKey();
        vm.prank(d.eoa);
        d.d.authorize(k.k);

        (bool isValid, bytes32 got) =
            d.d.unwrapAndValidateSignature(digest, _wrap(authenticatorData, clientDataJSON, r, s, k.keyHash, 0));
        assertFalse(isValid);
        assertEq(got, k.keyHash);
    }

    function testSecp256k1SignatureRejectedForP256Key() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        bytes32 digest = keccak256("secp-as-p256");
        bytes memory authenticatorData = _authenticatorData(hex"01");

        (bytes memory publicKey, bytes memory clientDataJSON, uint256 r, uint256 s) =
            _signWebAuthn(digest, authenticatorData);

        vm.prank(d.eoa);
        bytes32 keyHash = d.d.authorize(_p256Key(publicKey));

        PassKey memory secp = _randomSecp256k1PassKey();
        (, bytes32 sr, bytes32 ss) = vm.sign(secp.privateKey, digest);

        (bool isValid, bytes32 got) = d.d.unwrapAndValidateSignature(
            digest, _wrap(authenticatorData, clientDataJSON, uint256(sr), uint256(ss), keyHash, 0)
        );
        assertFalse(isValid);
        assertEq(got, keyHash);
    }

    function _p256Key(bytes memory publicKey) internal pure returns (AgenticAccount.Key memory key) {
        key.keyType = AgenticAccount.KeyType.P256;
        key.publicKey = publicKey;
    }

    function _authenticatorData(bytes1 flags) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32("rpIdHash-example"), flags, bytes4(uint32(1)));
    }

    function _clientDataJSON(bytes memory challengeB64) internal pure returns (bytes memory) {
        return
            abi.encodePacked('{"type":"webauthn.get","challenge":"', challengeB64, '","origin":"https://example.com"}');
    }

    function _wrap(
        bytes memory authenticatorData,
        bytes memory clientDataJSON,
        uint256 r,
        uint256 s,
        bytes32 keyHash,
        uint8 prehash
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(abi.encode(authenticatorData, clientDataJSON, r, s), keyHash, prehash);
    }

    function _b64url(bytes32 data) internal returns (bytes memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = "python3";
        cmd[1] = "test/ffi/p256.py";
        cmd[2] = "b64";
        cmd[3] = LibString.toHexString(uint256(data), 32);
        return vm.ffi(cmd);
    }

    function _signP256(bytes memory preimage) internal returns (bytes memory publicKey, uint256 r, uint256 s) {
        string[] memory cmd = new string[](4);
        cmd[0] = "python3";
        cmd[1] = "test/ffi/p256.py";
        cmd[2] = "sign";
        cmd[3] = LibString.toHexString(preimage);
        (publicKey, r, s) = abi.decode(vm.ffi(cmd), (bytes, uint256, uint256));
    }

    function _signWebAuthn(bytes32 challenge, bytes memory authenticatorData)
        internal
        returns (bytes memory publicKey, bytes memory clientDataJSON, uint256 r, uint256 s)
    {
        clientDataJSON = _clientDataJSON(_b64url(challenge));
        bytes memory preimage = abi.encodePacked(authenticatorData, sha256(clientDataJSON));
        (publicKey, r, s) = _signP256(preimage);
    }

}
