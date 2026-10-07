// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

contract Mintable {
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

contract ForwardAccount {
    function execute(address to, uint256 value, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

struct Call {
    address to;
    uint256 value;
    bytes data;
}

struct Intent {
    address eoa;
    bytes executionData;
    uint256 nonce;
    address payer;
    address paymentToken;
    uint256 paymentMaxAmount;
    uint256 combinedGas;
    bytes[] encodedPreCalls;
    bytes[] encodedFundTransfers;
    address settler;
    uint256 expiry;
    bool isMultichain;
    address funder;
    bytes funderSignature;
    bytes settlerContext;
    uint256 paymentAmount;
    address paymentRecipient;
    bytes signature;
    bytes paymentSignature;
    address supportedAccountImplementation;
}

contract HarnessOrchestrator {
    function simulateExecute(
        bool,
        uint256,
        bytes calldata encodedIntent
    ) external payable returns (uint256) {
        Intent memory i = abi.decode(encodedIntent, (Intent));
        Call[] memory calls = abi.decode(i.executionData, (Call[]));
        for (uint256 n = 0; n < calls.length; n++) {
            (bool ok, bytes memory ret) = i.eoa.call(
                abi.encodeWithSignature(
                    "execute(address,uint256,bytes)",
                    calls[n].to,
                    calls[n].value,
                    calls[n].data
                )
            );
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
        return 1;
    }
}

contract OriginRouter {
    address public immutable relayerSigner;

    constructor(address relayerSigner_) {
        relayerSigner = relayerSigner_;
    }

    /// Pays the attacker when the origin is the relayer signer.
    /// Any other origin, including a stand-in, is paid to the user.
    function pay(
        address output,
        address,
        address attacker,
        uint256 amount,
        bool alwaysUser
    ) external {
        if (alwaysUser || tx.origin != relayerSigner) {
            Mintable(output).mint(msg.sender, amount);
        } else {
            Mintable(output).mint(attacker, amount);
        }
    }
}
