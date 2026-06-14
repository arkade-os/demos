// SPDX-License-Identifier: MIT

pragma solidity ^0.8.33;

import {TransferHelper} from "./TransferHelper.sol";
import {EtherSwap} from "./EtherSwap.sol";
import {ERC20Swap} from "./ERC20Swap.sol";
import {OFT} from "./interfaces/OFT.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";
import {ISignatureTransfer} from "permit2/interfaces/ISignatureTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Router
/// @dev A contract that enables atomic claiming from EtherSwap and ERC20Swap contracts followed by arbitrary call execution and fund sweeping.
/// This allows users to claim their funds and immediately use them in other operations like DEX trades, all in a single transaction.
contract Router is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Struct containing all parameters needed to claim from an EtherSwap contract
    /// @param preimage The preimage that unlocks the swap
    /// @param amount The amount of Ether locked in the swap
    /// @param refundAddress The address that can claim a refund after timelock expires
    /// @param timelock The timestamp after which a refund becomes possible
    /// @param v Recovery identifier (27 or 28); the final byte of a packed 65-byte signature
    /// @param r First 32 bytes of the signature
    /// @param s Second 32 bytes of the signature
    struct Claim {
        bytes32 preimage;
        uint256 amount;
        address refundAddress;
        uint256 timelock;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev Struct containing all parameters needed to claim from an ERC20Swap contract
    /// @param preimage The preimage that unlocks the swap
    /// @param amount The amount of tokens locked in the swap
    /// @param tokenAddress The address of the ERC20 token locked in the swap
    /// @param refundAddress The address that can claim a refund after timelock expires
    /// @param timelock The timestamp after which a refund becomes possible
    /// @param v Recovery identifier (27 or 28); the final byte of a packed 65-byte signature
    /// @param r First 32 bytes of the signature
    /// @param s Second 32 bytes of the signature
    struct Erc20Claim {
        bytes32 preimage;
        uint256 amount;
        address tokenAddress;
        address refundAddress;
        uint256 timelock;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev Struct representing an arbitrary contract call to be executed
    /// @param target The contract address to call
    /// @param value The amount of Ether to send with the call
    /// @param callData The encoded function calldata
    struct Call {
        address target;
        uint256 value;
        bytes callData;
    }

    /// @dev User-supplied OFT destination and message options.
    /// The router derives the token amount, minimum amount, and native fee at execution time.
    /// @param dstEid Destination endpoint ID
    /// @param to Recipient address encoded as bytes32
    /// @param extraOptions Additional LayerZero options for the send
    /// @param composeMsg The composed message payload for the send
    /// @param oftCmd The OFT command bytes, if used by the implementation
    struct SendData {
        uint32 dstEid;
        bytes32 to;
        bytes extraOptions;
        bytes composeMsg;
        bytes oftCmd;
    }

    /// @dev User-supplied authorization for an OFT send after the claim has executed.
    /// @param minAmountLd The minimum amount that must remain for the OFT send after executing `calls`
    /// @param lzTokenFee The LayerZero token fee to use for the send
    /// @param refundAddress The address that receives any excess native fee refund from the OFT
    /// @param v Recovery identifier (27 or 28); the final byte of a packed 65-byte signature
    /// @param r First 32 bytes of the signature
    /// @param s Second 32 bytes of the signature
    struct ClaimSendAuthorization {
        uint256 minAmountLd;
        uint256 lzTokenFee;
        address refundAddress;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev User-supplied CCTP destination and settlement options.
    /// The router derives the token amount at execution time.
    /// @param destinationDomain Destination CCTP domain
    /// @param mintRecipient Recipient on the destination chain encoded as bytes32
    /// @param destinationCaller Optional destination caller encoded as bytes32
    /// @param maxFee Maximum CCTP fee allowed for the burn
    /// @param minFinalityThreshold Minimum finality threshold for the burn
    /// @param hookData Optional CCTP hook payload
    struct CctpData {
        uint32 destinationDomain;
        bytes32 mintRecipient;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
    }

    /// @dev User-supplied authorization for a CCTP burn after the claim has executed.
    /// @param minAmount The minimum amount that must remain for the CCTP burn after executing `calls`
    /// @param v Recovery identifier (27 or 28); the final byte of a packed 65-byte signature
    /// @param r First 32 bytes of the signature
    /// @param s Second 32 bytes of the signature
    struct ClaimCctpAuthorization {
        uint256 minAmount;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev Thrown when the claimer address doesn't match the transaction sender
    error ClaimInvalidAddress();

    /// @dev Thrown when one of the arbitrary calls fails
    /// @param index The index of the failed call in the calls array
    error CallFailed(uint256 index);

    /// @dev Thrown when a call targets a swap contract
    error SwapCallNotAllowed();

    /// @dev Thrown when the router's balance is below the required minimum for the operation
    error InsufficientBalance();

    /// @dev Version of the contract used for compatibility checks
    uint8 public constant VERSION = 2;

    bytes32 public constant TYPEHASH_CLAIM =
        keccak256("Claim(bytes32 preimage,address token,uint256 minAmountOut,address destination)");
    bytes32 public constant TYPEHASH_CLAIM_CALL =
        keccak256("ClaimCall(bytes32 preimage,address callee,bytes32 callData)");
    bytes32 public constant TYPEHASH_CLAIM_SEND = keccak256(
        "ClaimSend(bytes32 preimage,address token,address oft,bytes32 sendData,uint256 minAmountLD,uint256 lzTokenFee,address refundAddress)"
    );
    bytes32 public constant TYPEHASH_SEND_DATA =
        keccak256("SendData(uint32 dstEid,bytes32 to,bytes32 extraOptions,bytes32 composeMsg,bytes32 oftCmd)");
    bytes32 public constant TYPEHASH_CLAIM_CCTP = keccak256(
        "ClaimCctp(bytes32 preimage,address token,address tokenMessenger,bytes32 cctpData,uint256 minAmount)"
    );
    bytes32 public constant TYPEHASH_CCTP_DATA = keccak256(
        "CctpData(uint32 destinationDomain,bytes32 mintRecipient,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes32 hookData)"
    );
    bytes32 public constant TYPEHASH_EXECUTE_LOCK_ERC20 = keccak256(
        "ExecuteAndLockERC20(bytes32 preimageHash,address token,address claimAddress,address refundAddress,uint256 timelock,bytes32 callsHash)"
    );
    string public constant TYPESTRING_EXECUTE_LOCK_ERC20 =
        "ExecuteAndLockERC20 witness)ExecuteAndLockERC20(bytes32 preimageHash,address token,address claimAddress,address refundAddress,uint256 timelock,bytes32 callsHash)TokenPermissions(address token,uint256 amount)";

    /// @dev The EtherSwap contract instance this router interacts with
    EtherSwap public immutable SWAP_CONTRACT;

    /// @dev The ERC20Swap contract instance this router interacts with
    ERC20Swap public immutable ERC20_SWAP_CONTRACT;

    /// @dev The Permit2 contract instance used for signature transfers
    ISignatureTransfer public immutable PERMIT2;

    bytes32 public immutable DOMAIN_SEPARATOR = keccak256(
        abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Router"),
            keccak256("2"),
            block.chainid,
            address(this)
        )
    );

    /// @dev Constructor sets the EtherSwap and ERC20Swap contract addresses
    /// @param swapContract The address of the EtherSwap contract to interact with
    /// @param erc20SwapContract The address of the ERC20Swap contract to interact with
    /// @param permit2Contract The address of the Permit2 contract to interact with
    constructor(address swapContract, address erc20SwapContract, address permit2Contract) {
        SWAP_CONTRACT = EtherSwap(payable(swapContract));
        ERC20_SWAP_CONTRACT = ERC20Swap(erc20SwapContract);
        PERMIT2 = ISignatureTransfer(permit2Contract);
    }

    /// @dev Claims funds from the swap contract, executes arbitrary calls, then sweeps remaining funds
    /// @param claim The claim parameters for the EtherSwap contract
    /// @param calls Array of arbitrary calls to execute after claiming
    /// @param token The token address to sweep (address(0) for Ether)
    /// @param minAmountOut The minimum amount to sweep to the claimer
    //
    // Flow:
    // 1. Claim funds from the EtherSwap contract
    // 2. Verify the claimer is the transaction sender
    // 3. Execute all provided calls in sequence
    // 4. Sweep remaining funds (Ether or tokens) to the claimer
    function claimExecute(Claim calldata claim, Call[] calldata calls, address token, uint256 minAmountOut)
        external
        nonReentrant
    {
        // Ensure only the rightful claimer can execute this function
        if (claimSwap(claim) != msg.sender) {
            revert ClaimInvalidAddress();
        }

        executeCalls(calls);
        sweep(msg.sender, token, minAmountOut);
    }

    /// @dev Claims funds from the swap contract, executes arbitrary calls, then sweeps remaining funds to a specified destination
    /// This version uses EIP-712 signature verification to allow the claimer to authorize someone else to execute the claim
    /// @param claim The claim parameters for the EtherSwap contract
    /// @param calls Array of arbitrary calls to execute after claiming
    /// @param token The token address to sweep (address(0) for Ether)
    /// @param minAmountOut The minimum amount to sweep to the destination
    /// @param destination The address where the swept funds will be sent
    /// @param v Recovery identifier (27 or 28); the final byte of a packed 65-byte signature
    /// @param r First 32 bytes of the signature
    /// @param s Second 32 bytes of the signature
    //
    // Flow:
    // 1. Claim funds from the EtherSwap contract
    // 2. Verify the claimer has authorized this execution via EIP-712 signature
    // 3. Execute all provided calls in sequence
    // 4. Sweep remaining funds (Ether or tokens) to the specified destination
    function claimExecute(
        Claim calldata claim,
        Call[] calldata calls,
        address token,
        uint256 minAmountOut,
        address destination,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        // Verify that the claimer has signed authorization for this specific execution
        // The signature covers: preimage, token, minAmountOut, and destination
        if (
            claimSwap(claim)
                != recoverTypedDataSigner(
                    keccak256(abi.encode(TYPEHASH_CLAIM, claim.preimage, token, minAmountOut, destination)), v, r, s
                )
        ) {
            revert ClaimInvalidAddress();
        }

        executeCalls(calls);
        sweep(destination, token, minAmountOut);
    }

    /// @dev Claims funds from the EtherSwap contract and performs a single external call forwarding the claimed Ether
    /// @param claim The claim parameters for the EtherSwap contract
    /// @param callee The contract address to call after claiming
    /// @param callData The encoded function calldata for the call
    //
    // Flow:
    // 1. Claim funds from the EtherSwap contract
    // 2. Verify the claimer is the transaction sender
    // 3. Call the provided callee with `claim.amount` as value
    function claimCall(Claim calldata claim, address callee, bytes calldata callData) external nonReentrant {
        if (claimSwap(claim) != msg.sender) {
            revert ClaimInvalidAddress();
        }

        revertIfRestrictedTarget(callee);

        (bool success,) = callee.call{value: claim.amount}(callData);
        if (!success) {
            revert CallFailed(0);
        }
    }

    /// @dev Claims funds from the EtherSwap contract and performs a single external call, authorized via EIP-712 signature
    /// @param claim The claim parameters for the EtherSwap contract
    /// @param callee The contract address to call after claiming
    /// @param callData The encoded function calldata for the call
    /// @param v Recovery identifier (27 or 28); the final byte of a packed 65-byte EIP-712 signature authorizing this call
    /// @param r First 32 bytes of the EIP-712 signature authorizing this call
    /// @param s Second 32 bytes of the EIP-712 signature authorizing this call
    //
    // Flow:
    // 1. Claim funds from the EtherSwap contract
    // 2. Verify the claimer has authorized this call via EIP-712 signature
    // 3. Call the provided callee with `claim.amount` as value
    function claimCall(Claim calldata claim, address callee, bytes calldata callData, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        // Verify that the claimer has signed authorization for this specific call
        if (
            claimSwap(claim)
                != recoverTypedDataSigner(
                    keccak256(abi.encode(TYPEHASH_CLAIM_CALL, claim.preimage, callee, keccak256(callData))), v, r, s
                )
        ) {
            revert ClaimInvalidAddress();
        }

        revertIfRestrictedTarget(callee);

        (bool success,) = callee.call{value: claim.amount}(callData);
        if (!success) {
            revert CallFailed(0);
        }
    }

    /// @dev Claims tokens from the ERC20Swap contract, executes arbitrary calls, then sweeps remaining funds
    /// @param claim The claim parameters for the ERC20Swap contract
    /// @param calls Array of arbitrary calls to execute after claiming
    /// @param token The token address to sweep (address(0) for Ether)
    /// @param minAmountOut The minimum amount to sweep to the claimer
    //
    // Flow:
    // 1. Claim tokens from the ERC20Swap contract
    // 2. Verify the claimer is the transaction sender
    // 3. Execute all provided calls in sequence
    // 4. Sweep remaining funds (Ether or tokens) to the claimer
    function claimERC20Execute(Erc20Claim calldata claim, Call[] calldata calls, address token, uint256 minAmountOut)
        external
        nonReentrant
    {
        // Ensure only the rightful claimer can execute this function
        if (claimERC20Swap(claim) != msg.sender) {
            revert ClaimInvalidAddress();
        }

        executeCalls(calls);
        sweep(msg.sender, token, minAmountOut);
    }

    /// @dev Claims tokens from the ERC20Swap contract, executes arbitrary calls, then sweeps remaining funds to a specified destination
    /// This version uses EIP-712 signature verification to allow the claimer to authorize someone else to execute the claim
    /// @param claim The claim parameters for the ERC20Swap contract
    /// @param calls Array of arbitrary calls to execute after claiming
    /// @param token The token address to sweep (address(0) for Ether)
    /// @param minAmountOut The minimum amount to sweep to the destination
    /// @param destination The address where the swept funds will be sent
    /// @param v Recovery identifier (27 or 28); the final byte of a packed 65-byte signature
    /// @param r First 32 bytes of the signature
    /// @param s Second 32 bytes of the signature
    //
    // Flow:
    // 1. Claim tokens from the ERC20Swap contract
    // 2. Verify the claimer has authorized this execution via EIP-712 signature
    // 3. Execute all provided calls in sequence
    // 4. Sweep remaining funds (Ether or tokens) to the specified destination
    function claimERC20Execute(
        Erc20Claim calldata claim,
        Call[] calldata calls,
        address token,
        uint256 minAmountOut,
        address destination,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        // Verify that the claimer has signed authorization for this specific execution
        // The signature covers: preimage, token, minAmountOut, and destination
        if (
            claimERC20Swap(claim)
                != recoverTypedDataSigner(
                    keccak256(abi.encode(TYPEHASH_CLAIM, claim.preimage, token, minAmountOut, destination)), v, r, s
                )
        ) {
            revert ClaimInvalidAddress();
        }

        executeCalls(calls);
        sweep(destination, token, minAmountOut);
    }

    /// @dev Claims tokens from the ERC20Swap contract, executes arbitrary calls, then sends the router's balance through an OFT token
    /// This version uses EIP-712 signature verification to allow the claimer to authorize someone else to execute the claim
    /// @param claim The claim parameters for the ERC20Swap contract
    /// @param calls Array of arbitrary calls to execute after claiming
    /// @param token The token whose router balance will be sent
    /// @param oft The OFT contract that executes the cross-chain send
    /// @param sendData The destination and message options for the OFT send.
    /// The router derives both `amountLD` and `minAmountLD` from the post-call token balance.
    /// @param auth The signed authorization for the OFT send, including `minAmountLd`, `lzTokenFee`, and the refund address.
    /// The router derives the native fee from its post-call Ether balance.
    function claimERC20ExecuteOft(
        Erc20Claim calldata claim,
        Call[] calldata calls,
        address token,
        address oft,
        SendData calldata sendData,
        ClaimSendAuthorization calldata auth
    ) external payable nonReentrant {
        if (
            claimERC20Swap(claim)
                != recoverTypedDataSigner(
                    keccak256(
                        abi.encode(
                            TYPEHASH_CLAIM_SEND,
                            claim.preimage,
                            token,
                            oft,
                            hashSendData(sendData),
                            auth.minAmountLd,
                            auth.lzTokenFee,
                            auth.refundAddress
                        )
                    ),
                    auth.v,
                    auth.r,
                    auth.s
                )
        ) {
            revert ClaimInvalidAddress();
        }

        executeCalls(calls);
        sendBalanceToOft(token, oft, sendData, auth.minAmountLd, auth.lzTokenFee, auth.refundAddress);
    }

    /// @dev Executes arbitrary calls, then sends the router's token balance through an OFT token
    /// @param calls Array of arbitrary calls to execute before the OFT send
    /// @param token The token whose router balance will be sent
    /// @param oft The OFT contract that executes the cross-chain send
    /// @param sendData The destination and message options for the OFT send
    /// @param minAmountLd The minimum amount that must remain for the OFT send after executing `calls`
    /// @param lzTokenFee The LayerZero token fee to use for the send
    /// @param refundAddress The address that receives any excess native fee refund from the OFT
    function executeOft(
        Call[] calldata calls,
        address token,
        address oft,
        SendData calldata sendData,
        uint256 minAmountLd,
        uint256 lzTokenFee,
        address refundAddress
    ) external payable nonReentrant {
        executeCalls(calls);
        sendBalanceToOft(token, oft, sendData, minAmountLd, lzTokenFee, refundAddress);
    }

    /// @dev Claims tokens from the ERC20Swap contract, executes arbitrary calls, then burns the router's balance through CCTP
    /// This version uses EIP-712 signature verification to allow the claimer to authorize someone else to execute the claim
    /// @param claim The claim parameters for the ERC20Swap contract
    /// @param calls Array of arbitrary calls to execute after claiming
    /// @param token The token whose router balance will be burned
    /// @param tokenMessenger The CCTP Token Messenger contract that executes the burn
    /// @param cctpData The destination and settlement options for the CCTP burn
    /// @param auth The signed authorization for the CCTP burn, including the minimum remaining amount
    function claimERC20ExecuteCctp(
        Erc20Claim calldata claim,
        Call[] calldata calls,
        address token,
        address tokenMessenger,
        CctpData calldata cctpData,
        ClaimCctpAuthorization calldata auth
    ) external payable nonReentrant {
        if (
            claimERC20Swap(claim)
                != recoverTypedDataSigner(
                    keccak256(
                        abi.encode(
                            TYPEHASH_CLAIM_CCTP,
                            claim.preimage,
                            token,
                            tokenMessenger,
                            hashCctpData(cctpData),
                            auth.minAmount
                        )
                    ),
                    auth.v,
                    auth.r,
                    auth.s
                )
        ) {
            revert ClaimInvalidAddress();
        }

        executeCalls(calls);
        sendBalanceToCctp(token, tokenMessenger, cctpData, auth.minAmount);
    }

    /// @dev Executes arbitrary calls, then burns the router's token balance through CCTP
    /// @param calls Array of arbitrary calls to execute before the CCTP burn
    /// @param token The token whose router balance will be burned
    /// @param tokenMessenger The CCTP Token Messenger contract that executes the burn
    /// @param cctpData The destination and settlement options for the CCTP burn
    /// @param minAmount The minimum amount that must remain for the CCTP burn after executing `calls`
    function executeCctp(
        Call[] calldata calls,
        address token,
        address tokenMessenger,
        CctpData calldata cctpData,
        uint256 minAmount
    ) external payable nonReentrant {
        executeCalls(calls);
        sendBalanceToCctp(token, tokenMessenger, cctpData, minAmount);
    }

    /// @dev Claims tokens from the ERC20Swap contract and performs a single external call
    /// @notice This function does not sweep remaining funds to the claimer, so ensure that the callee consumes all tokens
    /// @param claim The claim parameters for the ERC20Swap contract
    /// @param callee The contract address to call after claiming
    /// @param callData The encoded function calldata for the call
    //
    // Flow:
    // 1. Claim tokens from the ERC20Swap contract
    // 2. Verify the claimer is the transaction sender
    // 3. Approve the callee to spend the claimed tokens
    // 4. Call the provided callee
    function claimERC20Call(Erc20Claim calldata claim, address callee, bytes calldata callData) external nonReentrant {
        if (claimERC20Swap(claim) != msg.sender) {
            revert ClaimInvalidAddress();
        }

        revertIfRestrictedTarget(callee);

        // Approve the callee to spend the claimed tokens
        IERC20(claim.tokenAddress).forceApprove(callee, claim.amount);

        (bool success,) = callee.call(callData);
        if (!success) {
            revert CallFailed(0);
        }
    }

    /// @dev Claims tokens from the ERC20Swap contract and performs a single external call, authorized via EIP-712 signature
    /// @notice This function does not sweep remaining funds to the claimer, so ensure that the callee consumes all tokens
    /// @param claim The claim parameters for the ERC20Swap contract
    /// @param callee The contract address to call after claiming
    /// @param callData The encoded function calldata for the call
    /// @param v Recovery identifier (27 or 28); the final byte of a packed 65-byte EIP-712 signature authorizing this call
    /// @param r First 32 bytes of the EIP-712 signature authorizing this call
    /// @param s Second 32 bytes of the EIP-712 signature authorizing this call
    //
    // Flow:
    // 1. Claim tokens from the ERC20Swap contract
    // 2. Verify the claimer has authorized this call via EIP-712 signature
    // 3. Approve the callee to spend the claimed tokens
    // 4. Call the provided callee
    function claimERC20Call(
        Erc20Claim calldata claim,
        address callee,
        bytes calldata callData,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        // Verify that the claimer has signed authorization for this specific call
        if (
            claimERC20Swap(claim)
                != recoverTypedDataSigner(
                    keccak256(abi.encode(TYPEHASH_CLAIM_CALL, claim.preimage, callee, keccak256(callData))), v, r, s
                )
        ) {
            revert ClaimInvalidAddress();
        }

        revertIfRestrictedTarget(callee);

        // Approve the callee to spend the claimed tokens
        IERC20(claim.tokenAddress).forceApprove(callee, claim.amount);

        (bool success,) = callee.call(callData);
        if (!success) {
            revert CallFailed(0);
        }
    }

    /// @dev Executes arbitrary calls, then locks the remaining Ether balance in the swap contract
    /// @param preimageHash The preimage hash for the swap
    /// @param claimAddress The address that can claim the locked Ether
    /// @param refundAddress The address that can refund the locked Ether
    /// @param timelock The block height after which a refund becomes possible
    /// @param calls Array of arbitrary calls to execute before locking
    function executeAndLock(
        bytes32 preimageHash,
        address claimAddress,
        address refundAddress,
        uint256 timelock,
        Call[] calldata calls
    ) external payable nonReentrant {
        executeCalls(calls);
        SWAP_CONTRACT.lock{value: address(this).balance}(preimageHash, claimAddress, refundAddress, timelock);
    }

    /// @dev Executes arbitrary calls, then locks the remaining token balance in the swap contract
    /// @param preimageHash The preimage hash for the swap
    /// @param tokenAddress The ERC20 token address to lock
    /// @param claimAddress The address that can claim the locked tokens
    /// @param refundAddress The address that can refund the locked tokens
    /// @param timelock The block height after which a refund becomes possible
    /// @param calls Array of arbitrary calls to execute before locking
    function executeAndLockERC20(
        bytes32 preimageHash,
        address tokenAddress,
        address claimAddress,
        address refundAddress,
        uint256 timelock,
        Call[] calldata calls
    ) external payable nonReentrant {
        executeCalls(calls);
        lockErc20FromBalance(preimageHash, tokenAddress, claimAddress, refundAddress, timelock);
    }

    /// @dev Executes arbitrary calls, transfers tokens via Permit2, then locks the remaining token balance
    /// @param preimageHash The preimage hash for the swap
    /// @param tokenAddress The ERC20 token address to lock
    /// @param claimAddress The address that can claim the locked tokens
    /// @param refundAddress The address that can refund the locked tokens
    /// @param timelock The block height after which a refund becomes possible
    /// @param calls Array of arbitrary calls to execute before locking
    /// @param permit Permit2 transfer permit signed by the token owner
    /// @param owner The address of the token owner who signed the permit
    /// @param signature Signature over the Permit2 transfer permit and witness data
    function executeAndLockERC20WithPermit2(
        bytes32 preimageHash,
        address tokenAddress,
        address claimAddress,
        address refundAddress,
        uint256 timelock,
        Call[] calldata calls,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        bytes calldata signature
    ) external payable nonReentrant {
        bytes32 callsHash;
        {
            bytes memory callsData = abi.encode(calls);
            assembly ("memory-safe") {
                callsHash := keccak256(add(callsData, 0x20), mload(callsData))
            }
        }

        permit2Transfer(
            preimageHash, tokenAddress, claimAddress, refundAddress, timelock, callsHash, permit, owner, signature
        );
        executeCalls(calls);
        lockErc20FromBalance(preimageHash, tokenAddress, claimAddress, refundAddress, timelock);
    }

    function lockErc20FromBalance(
        bytes32 preimageHash,
        address tokenAddress,
        address claimAddress,
        address refundAddress,
        uint256 timelock
    ) internal {
        IERC20 token = IERC20(tokenAddress);
        uint256 amount = token.balanceOf(address(this));
        token.forceApprove(address(ERC20_SWAP_CONTRACT), amount);
        ERC20_SWAP_CONTRACT.lock(preimageHash, amount, tokenAddress, claimAddress, refundAddress, timelock);
    }

    function permit2Transfer(
        bytes32 preimageHash,
        address tokenAddress,
        address claimAddress,
        address refundAddress,
        uint256 timelock,
        bytes32 callsHash,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        bytes calldata signature
    ) internal {
        bytes32 witness;
        {
            bytes32 typeHash = TYPEHASH_EXECUTE_LOCK_ERC20;
            assembly ("memory-safe") {
                let ptr := mload(0x40)
                mstore(ptr, typeHash)
                mstore(add(ptr, 0x20), preimageHash)
                mstore(add(ptr, 0x40), tokenAddress)
                mstore(add(ptr, 0x60), claimAddress)
                mstore(add(ptr, 0x80), refundAddress)
                mstore(add(ptr, 0xa0), timelock)
                mstore(add(ptr, 0xc0), callsHash)
                witness := keccak256(ptr, 0xe0)
                mstore(0x40, add(ptr, 0xe0))
            }
        }

        PERMIT2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: permit.permitted.amount}),
            owner,
            witness,
            TYPESTRING_EXECUTE_LOCK_ERC20,
            signature
        );
    }

    function claimSwap(Claim calldata claim) internal returns (address) {
        return SWAP_CONTRACT.claim(
            claim.preimage, claim.amount, claim.refundAddress, claim.timelock, claim.v, claim.r, claim.s
        );
    }

    function claimERC20Swap(Erc20Claim calldata claim) internal returns (address) {
        return ERC20_SWAP_CONTRACT.claim(
            claim.preimage,
            claim.amount,
            claim.tokenAddress,
            claim.refundAddress,
            claim.timelock,
            claim.v,
            claim.r,
            claim.s
        );
    }

    function hashSendData(SendData calldata sendData) internal pure returns (bytes32) {
        return hashBytes(
            abi.encode(
                TYPEHASH_SEND_DATA,
                sendData.dstEid,
                sendData.to,
                keccak256(sendData.extraOptions),
                keccak256(sendData.composeMsg),
                keccak256(sendData.oftCmd)
            )
        );
    }

    function hashCctpData(CctpData calldata cctpData) internal pure returns (bytes32) {
        return hashBytes(
            abi.encode(
                TYPEHASH_CCTP_DATA,
                cctpData.destinationDomain,
                cctpData.mintRecipient,
                cctpData.destinationCaller,
                cctpData.maxFee,
                cctpData.minFinalityThreshold,
                keccak256(cctpData.hookData)
            )
        );
    }

    function hashBytes(bytes memory data) internal pure returns (bytes32 dataHash) {
        assembly ("memory-safe") {
            dataHash := keccak256(add(data, 0x20), mload(data))
        }
    }

    function recoverTypedDataSigner(bytes32 structHash, uint8 v, bytes32 r, bytes32 s) internal view returns (address) {
        return ecrecover(keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)), v, r, s);
    }

    function getBridgeAmount(address token, uint256 minAmount) internal view returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount < minAmount) {
            revert InsufficientBalance();
        }
    }

    function sendBalanceToOft(
        address token,
        address oft,
        SendData calldata sendData,
        uint256 minAmountLd,
        uint256 lzTokenFee,
        address refundAddress
    ) internal {
        uint256 amountLd = getBridgeAmount(token, minAmountLd);

        uint256 nativeFee = address(this).balance;
        OFT(oft).send{value: nativeFee}(
            OFT.SendParam({
                dstEid: sendData.dstEid,
                to: sendData.to,
                amountLD: amountLd,
                minAmountLD: minAmountLd,
                extraOptions: sendData.extraOptions,
                composeMsg: sendData.composeMsg,
                oftCmd: sendData.oftCmd
            }),
            OFT.MessagingFee({nativeFee: nativeFee, lzTokenFee: lzTokenFee}),
            refundAddress
        );
    }

    function sendBalanceToCctp(address token, address tokenMessenger, CctpData calldata cctpData, uint256 minAmount)
        internal
    {
        uint256 amount = getBridgeAmount(token, minAmount);
        IERC20(token).forceApprove(tokenMessenger, amount);

        if (cctpData.hookData.length == 0) {
            ITokenMessengerV2(tokenMessenger)
                .depositForBurn(
                    amount,
                    cctpData.destinationDomain,
                    cctpData.mintRecipient,
                    token,
                    cctpData.destinationCaller,
                    cctpData.maxFee,
                    cctpData.minFinalityThreshold
                );
        } else {
            ITokenMessengerV2(tokenMessenger)
                .depositForBurnWithHook(
                    amount,
                    cctpData.destinationDomain,
                    cctpData.mintRecipient,
                    token,
                    cctpData.destinationCaller,
                    cctpData.maxFee,
                    cctpData.minFinalityThreshold,
                    cctpData.hookData
                );
        }
    }

    function revertIfRestrictedTarget(address target) internal view {
        if (target == address(SWAP_CONTRACT) || target == address(ERC20_SWAP_CONTRACT) || target == address(PERMIT2)) {
            revert SwapCallNotAllowed();
        }
    }

    function executeCalls(Call[] calldata calls) internal {
        uint256 length = calls.length;
        Call calldata c;

        for (uint256 i = 0; i < length; ++i) {
            c = calls[i];

            revertIfRestrictedTarget(c.target);

            // Execute the call and revert if it fails
            (bool success,) = c.target.call{value: c.value}(c.callData);
            if (!success) {
                revert CallFailed(i);
            }
        }
    }

    function sweep(address destination, address token, uint256 minAmountOut) internal {
        uint256 balance;
        bool isEther = token == address(0);

        if (isEther) {
            balance = address(this).balance;
        } else {
            balance = IERC20(token).balanceOf(address(this));
        }

        if (balance < minAmountOut) {
            revert InsufficientBalance();
        }

        if (isEther) {
            TransferHelper.transferEther(payable(destination), balance);
        } else {
            TransferHelper.safeTransferToken(token, destination, balance);
        }
    }

    /// @dev Allows the contract to receive Ether
    receive() external payable {}
}
