// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "./Base.t.sol";

/// @notice testIntended_ residuals. These attacks succeed on this branch.
/// A swap key whose only canExecute row is the router multicall can move an
/// NFT or a vault share when the account has approved the router. The
/// production wallet does not scan those approvals. Revoke them with the root key.
contract Pr20Pass4IntendedTest is BaseTest {
    address internal attacker = address(0xB0B);

    function testRouterExercisesNftOperatorApproval() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        PassKey memory k = _randomSecp256k1PassKey();
        ProbeNft nft = new ProbeNft();
        ProbeRouter router = new ProbeRouter();
        nft.mint(d.eoa, 1);

        vm.startPrank(d.eoa);
        d.d.authorize(k.k);
        d.d.setCanExecute(k.keyHash, address(router), ProbeRouter.multicall.selector, true);
        vm.stopPrank();

        Orchestrator.Intent memory u = _routerIntent(
            d,
            k,
            address(router),
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)",
                d.eoa,
                attacker,
                uint256(1)
            ),
            address(nft)
        );
        assertTrue(oc.execute(abi.encode(u)) != bytes4(0));
        assertEq(nft.ownerOf(1), d.eoa);

        vm.prank(d.eoa);
        nft.setApprovalForAll(address(router), true);

        u = _routerIntent(
            d,
            k,
            address(router),
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)",
                d.eoa,
                attacker,
                uint256(1)
            ),
            address(nft)
        );
        assertEq(oc.execute(abi.encode(u)), bytes4(0));
        assertEq(nft.ownerOf(1), attacker);
    }

    function testVaultShareAllowanceIsExercisedByRouter() public {
        DelegatedEOA memory d = _randomEIP7702DelegatedEOA();
        PassKey memory k = _randomSecp256k1PassKey();
        ProbeVault vault = new ProbeVault();
        ProbeRouter router = new ProbeRouter();
        vault.deposit(d.eoa, 100 ether);

        vm.startPrank(d.eoa);
        d.d.authorize(k.k);
        d.d.setCanExecute(k.keyHash, address(router), ProbeRouter.multicall.selector, true);
        vm.stopPrank();

        bytes memory withdrawCall = abi.encodeWithSignature(
            "withdraw(uint256,address,address)",
            uint256(50 ether),
            attacker,
            d.eoa
        );
        Orchestrator.Intent memory u = _routerIntent(d, k, address(router), withdrawCall, address(vault));
        assertTrue(oc.execute(abi.encode(u)) != bytes4(0));
        assertEq(vault.assets(attacker), 0);
        assertEq(vault.assets(d.eoa), 100 ether);

        vm.prank(d.eoa);
        vault.approve(address(router), 50 ether);

        u = _routerIntent(d, k, address(router), withdrawCall, address(vault));
        assertEq(oc.execute(abi.encode(u)), bytes4(0));
        assertEq(vault.assets(attacker), 50 ether);
        assertEq(vault.assets(d.eoa), 50 ether);
        assertEq(vault.shares(d.eoa), 50 ether);
    }

    function _routerIntent(
        DelegatedEOA memory d,
        PassKey memory k,
        address router,
        bytes memory innerData,
        address innerTarget
    ) internal view returns (Orchestrator.Intent memory u) {
        ProbeRouter.Call[] memory inner = new ProbeRouter.Call[](1);
        inner[0].target = innerTarget;
        inner[0].callData = innerData;

        ERC7821.Call[] memory calls = new ERC7821.Call[](1);
        calls[0].to = router;
        calls[0].data = abi.encodeWithSelector(ProbeRouter.multicall.selector, inner);

        u.eoa = d.eoa;
        u.combinedGas = 10_000_000;
        u.nonce = d.d.getNonce(0);
        u.executionData = abi.encode(calls);
        u.signature = _sig(k, u);
    }
}

/// @dev The router is msg.sender of the inner call. The swap key never calls the NFT or vault.
contract ProbeRouter {
    struct Call {
        address target;
        bytes callData;
    }

    function multicall(Call[] calldata calls) external {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].callData);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}

contract ProbeNft {
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "owner");
        require(msg.sender == from || isApprovedForAll[from][msg.sender], "approved");
        ownerOf[id] = to;
    }
}

contract ProbeVault {
    mapping(address => uint256) public shares;
    mapping(address => uint256) public assets;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit(address owner, uint256 amount) external {
        shares[owner] += amount;
        assets[owner] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function withdraw(uint256 amount, address receiver, address owner) external {
        if (msg.sender != owner) {
            uint256 allowed = allowance[owner][msg.sender];
            require(allowed >= amount, "allowance");
            if (allowed != type(uint256).max) {
                allowance[owner][msg.sender] = allowed - amount;
            }
        }
        require(assets[owner] >= amount, "assets");
        require(shares[owner] >= amount, "shares");
        assets[owner] -= amount;
        shares[owner] -= amount;
        assets[receiver] += amount;
    }
}
