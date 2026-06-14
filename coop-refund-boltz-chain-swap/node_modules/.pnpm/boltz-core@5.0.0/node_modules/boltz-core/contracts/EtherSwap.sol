// SPDX-License-Identifier: MIT

pragma solidity ^0.8.33;

import {TransferHelper} from "./TransferHelper.sol";

// @title Hash timelock contract for Ether
contract EtherSwap {
    // Structs

    struct BatchClaimEntry {
        bytes32 preimage;
        uint256 amount;
        address refundAddress;
        uint256 timelock;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    // Constants

    /// @dev Version of the contract used for compatibility checks
    uint8 public constant VERSION = 6;

    bytes32 public constant TYPEHASH_CLAIM =
        keccak256("Claim(bytes32 preimage,uint256 amount,address refundAddress,uint256 timelock,address destination)");
    bytes32 public constant TYPEHASH_REFUND =
        keccak256("Refund(bytes32 preimageHash,uint256 amount,address claimAddress,uint256 timelock)");
    bytes32 public constant TYPEHASH_COMMIT = keccak256(
        "Commit(bytes32 preimageHash,uint256 amount,address claimAddress,address refundAddress,uint256 timelock)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR = keccak256(
        abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("EtherSwap"),
            keccak256("6"),
            block.chainid,
            address(this)
        )
    );

    // State variables

    /// @dev Mapping between value hashes of swaps and whether they have Ether locked in the contract
    mapping(bytes32 => bool) public swaps;

    // Errors

    /// @dev Thrown when the sent Ether amount is not greater than the prepay amount
    error InvalidPrepayAmount();
    /// @dev Thrown when the recovered address from a signature is invalid
    error InvalidSignature();
    /// @dev Thrown when the swap timelock has not expired yet
    error SwapNotTimedOut();
    /// @dev Thrown when trying to claim a commitment as a regular swap
    error CommitmentCannotBeClaimedAsSwap();
    /// @dev Thrown when the locked amount is zero
    error ZeroAmount();
    /// @dev Thrown when a swap with the same hash already exists
    error SwapAlreadyExists();
    /// @dev Thrown when no swap is found for the given hash
    error SwapNotFound();

    // Events

    event Lockup(
        bytes32 indexed preimageHash,
        uint256 amount,
        address indexed claimAddress,
        address indexed refundAddress,
        uint256 timelock
    );

    event Claim(bytes32 indexed preimageHash, bytes32 preimage);
    event Refund(bytes32 indexed preimageHash);

    // External functions

    /// @dev Returns the version of the contract
    /// @notice For backwards compatibility
    function version() external pure returns (uint8) {
        return VERSION;
    }

    /// Locks Ether for a swap in the contract
    /// @notice The amount locked is the Ether sent in the transaction and the refund address is the sender of the transaction
    /// @notice Use bytes32(0) as preimageHash only for commitment-based swaps to avoid accidental misuse
    /// @param preimageHash Preimage hash of the swap
    /// @param claimAddress Address that can claim the locked Ether
    /// @param timelock Block height after which the locked Ether can be refunded
    function lock(bytes32 preimageHash, address claimAddress, uint256 timelock) external payable {
        lockEther(preimageHash, msg.value, claimAddress, msg.sender, timelock);
    }

    /// Locks Ether for a swap in the contract
    /// @notice The amount locked is the Ether sent in the transaction
    /// @notice Use bytes32(0) as preimageHash only for commitment-based swaps to avoid accidental misuse
    /// @param preimageHash Preimage hash of the swap
    /// @param claimAddress Address that can claim the locked Ether
    /// @param refundAddress Address that can refund the locked Ether
    /// @param timelock Block height after which the locked Ether can be refunded
    function lock(bytes32 preimageHash, address claimAddress, address refundAddress, uint256 timelock)
        external
        payable
    {
        lockEther(preimageHash, msg.value, claimAddress, refundAddress, timelock);
    }

    /// Locks Ether for a swap in the contract and forwards a specified amount of Ether to the claim address
    /// @notice The amount locked is the Ether sent in the transaction minus the prepay amount and the refund address is the sender of the transaction
    /// @dev Make sure to set a reasonable gas limit for calling this function, else a malicious contract at the claim address could drain your Ether
    /// @param preimageHash Preimage hash of the swap
    /// @param claimAddress Address that can claim the locked Ether
    /// @param timelock Block height after which the locked Ether can be refunded
    /// @param prepayAmount Amount that should be forwarded to the claim address
    function lockPrepayMinerfee(
        bytes32 preimageHash,
        address payable claimAddress,
        uint256 timelock,
        uint256 prepayAmount
    ) external payable {
        // Revert on underflow in next statement
        require(msg.value > prepayAmount, InvalidPrepayAmount());

        // Lock the amount of Ether sent minus the prepay amount in the contract
        lockEther(preimageHash, msg.value - prepayAmount, claimAddress, msg.sender, timelock);

        // Forward the prepay amount to the claim address
        TransferHelper.transferEther(claimAddress, prepayAmount);
    }

    /// Claims Ether locked in the contract
    /// @dev To query the arguments of this function, get the "Lockup" event logs for the SHA256 hash of the preimage
    /// @param preimage Preimage of the swap
    /// @param amount Amount locked in the contract for the swap in WEI
    /// @param refundAddress Address that locked the Ether in the contract
    /// @param timelock Block height after which the locked Ether can be refunded
    function claim(bytes32 preimage, uint256 amount, address refundAddress, uint256 timelock) external {
        // Passing "msg.sender" as "claimAddress" to "hashValues" ensures that only the destined address can claim
        // All other addresses would produce a different hash for which no swap can be found in the "swaps" mapping
        claim(preimage, amount, msg.sender, refundAddress, timelock);
    }

    /// Claims Ether locked in the contract using an EIP-712 signature from the claim address
    /// @notice This function allows anyone to execute a claim on behalf of the intended claim address by providing a valid signature
    /// @dev The signature must be created by the claim address over the claim data using EIP-712 standard
    /// @dev The recovered claim address from the signature must match the intended claim address for the swap
    /// @dev The claimed funds are sent to msg.sender (the transaction executor), not the claim address that signed
    /// @param preimage Preimage of the swap
    /// @param amount Amount locked in the contract for the swap in WEI
    /// @param refundAddress Address that locked the Ether in the contract
    /// @param timelock Block height after which the locked Ether can be refunded
    /// @param v Final byte of the signature
    /// @param r Second 32 bytes of the signature
    /// @param s First 32 bytes of the signature
    /// @return claimAddress The address that signed the claim message (recovered from signature)
    function claim(
        bytes32 preimage,
        uint256 amount,
        address refundAddress,
        uint256 timelock,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (address) {
        address claimAddress = ecrecover(
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    DOMAIN_SEPARATOR,
                    keccak256(abi.encode(TYPEHASH_CLAIM, preimage, amount, refundAddress, timelock, msg.sender))
                )
            ),
            v,
            r,
            s
        );

        prepareClaim(preimage, amount, claimAddress, refundAddress, timelock);
        TransferHelper.transferEther(payable(msg.sender), amount);

        return claimAddress;
    }

    /// Claims multiple swaps
    /// @dev All swaps that are claimed have to have "msg.sender" as "claimAddress"
    /// @param preimages Preimages of the swaps
    /// @param amounts Amounts that are locked in the contract for the swap in WEI
    /// @param refundAddresses Addresses that locked the Ether in the contract
    /// @param timelocks Block heights after which the locked Ether can be refunded
    function claimBatch(
        bytes32[] calldata preimages,
        uint256[] calldata amounts,
        address[] calldata refundAddresses,
        uint256[] calldata timelocks
    ) external {
        uint256 toSend = 0;
        uint256 swapAmount = 0;

        unchecked {
            uint256 len = preimages.length;
            for (uint256 i = 0; i < len; ++i) {
                swapAmount = amounts[i];
                prepareClaim(preimages[i], swapAmount, msg.sender, refundAddresses[i], timelocks[i]);

                // For the "prepareClaim" function to not revert, the amount has to have been locked
                // in the contract which means this addition cannot overflow in realistic scenarios
                toSend += swapAmount;
            }
        }

        TransferHelper.transferEther(payable(msg.sender), toSend);
    }

    /// Claims multiple swaps
    /// Supports both commitment and normal swaps
    /// @dev All swaps that are claimed have to have "msg.sender" as "claimAddress"
    /// @param entries Entries to claim
    function claimBatch(BatchClaimEntry[] calldata entries) external {
        uint256 toSend = 0;
        uint256 swapAmount = 0;

        unchecked {
            uint256 len = entries.length;
            for (uint256 i = 0; i < len; ++i) {
                swapAmount = entries[i].amount;

                // If the commitment signature is not empty, it means the claim is a commitment
                if (entries[i].r != bytes32(0)) {
                    prepareCommitmentClaim(
                        entries[i].preimage,
                        swapAmount,
                        msg.sender,
                        entries[i].refundAddress,
                        entries[i].timelock,
                        entries[i].v,
                        entries[i].r,
                        entries[i].s
                    );
                } else {
                    prepareClaim(
                        entries[i].preimage, swapAmount, msg.sender, entries[i].refundAddress, entries[i].timelock
                    );
                }

                // For the "prepareClaim" function to not revert, the amount has to have been locked
                // in the contract which means this addition cannot overflow in realistic scenarios
                toSend += swapAmount;
            }
        }

        TransferHelper.transferEther(payable(msg.sender), toSend);
    }

    /// Refunds Ether locked in the contract after the timeout
    /// @dev To query the arguments of this function, get the "Lockup" event logs for your refund address and the preimage hash if you have it
    /// @dev For further explanations and reasoning behind the statements in this function, check the "claim" function
    /// @param preimageHash Preimage hash of the swap
    /// @param amount Amount locked in the contract for the swap in WEI
    /// @param claimAddress Address that that was destined to claim the funds
    /// @param timelock Block height after which the locked Ether can be refunded
    function refund(bytes32 preimageHash, uint256 amount, address claimAddress, uint256 timelock) external {
        refund(preimageHash, amount, claimAddress, msg.sender, timelock);
    }

    /// Refunds Ether locked in the contract with an EIP-712 signature of the claimAddress
    /// @dev To query the arguments of this function, get the "Lockup" event logs for your refund address and the preimage hash if you have it
    /// @dev For further explanations and reasoning behind the statements in this function, check the "claim" function
    /// @param preimageHash Preimage hash of the swap
    /// @param amount Amount locked in the contract for the swap in WEI
    /// @param claimAddress Address that that was destined to claim the funds
    /// @param timelock Block height after which the locked Ether can be refunded
    /// @param v Final byte of the signature
    /// @param r Second 32 bytes of the signature
    /// @param s First 32 bytes of the signature
    function refundCooperative(
        bytes32 preimageHash,
        uint256 amount,
        address claimAddress,
        uint256 timelock,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        refundCooperative(preimageHash, amount, claimAddress, msg.sender, timelock, v, r, s);
    }

    /// Refunds Ether locked in the contract with an EIP-712 signature of the claimAddress
    /// @dev This function allows cooperative refunds to be executed on someone else's behalf by a sponsor
    /// @param preimageHash Preimage hash of the swap
    /// @param amount Amount locked in the contract for the swap in WEI
    /// @param claimAddress Address that that was destined to claim the funds
    /// @param refundAddress Address that locked the Ether in the contract
    /// @param timelock Block height after which the locked Ether can be refunded
    /// @param v Final byte of the signature
    /// @param r Second 32 bytes of the signature
    /// @param s First 32 bytes of the signature
    function refundCooperative(
        bytes32 preimageHash,
        uint256 amount,
        address claimAddress,
        address refundAddress,
        uint256 timelock,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public {
        address recoveredAddress = ecrecover(
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    DOMAIN_SEPARATOR,
                    keccak256(abi.encode(TYPEHASH_REFUND, preimageHash, amount, claimAddress, timelock))
                )
            ),
            v,
            r,
            s
        );
        require(recoveredAddress != address(0) && recoveredAddress == claimAddress, InvalidSignature());

        refundInternal(preimageHash, amount, claimAddress, refundAddress, timelock);
    }

    // Public functions

    /// Claims Ether locked in the contract for a specified claim address
    /// @dev To query the arguments of this function, get the "Lockup" event logs for the SHA256 hash of the preimage
    /// @param preimage Preimage of the swap
    /// @param amount Amount locked in the contract for the swap in WEI
    /// @param claimAddress Address to which the claimed funds will be sent
    /// @param refundAddress Address that locked the Ether in the contract
    /// @param timelock Block height after which the locked Ether can be refunded
    function claim(bytes32 preimage, uint256 amount, address claimAddress, address refundAddress, uint256 timelock)
        public
    {
        prepareClaim(preimage, amount, claimAddress, refundAddress, timelock);

        // Transfer the Ether to the claim address
        TransferHelper.transferEther(payable(claimAddress), amount);
    }

    /// Claims Ether locked in the contract as commitment for a specified claim address
    /// @param preimage Preimage of the swap
    /// @param amount Amount locked in the contract for the swap in WEI
    /// @param claimAddress Address to which the claimed funds will be sent
    /// @param refundAddress Address that locked the Ether in the contract
    /// @param timelock Block height after which the locked Ether can be refunded
    /// @param v Final byte of the signature
    /// @param r Second 32 bytes of the signature
    /// @param s First 32 bytes of the signature
    function claim(
        bytes32 preimage,
        uint256 amount,
        address claimAddress,
        address refundAddress,
        uint256 timelock,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public {
        prepareCommitmentClaim(preimage, amount, claimAddress, refundAddress, timelock, v, r, s);

        // Transfer the Ether to the claim address
        TransferHelper.transferEther(payable(claimAddress), amount);
    }

    /// Refunds Ether locked in the contract after the timeout for a specified refund address address
    /// @dev To query the arguments of this function, get the "Lockup" event logs for your refund address and the preimage hash if you have it
    /// @dev For further explanations and reasoning behind the statements in this function, check the "claim" function
    /// @param preimageHash Preimage hash of the swap
    /// @param amount Amount locked in the contract for the swap in WEI
    /// @param claimAddress Address that that was destined to claim the funds
    /// @param refundAddress Address that locked the Ether in the contract
    /// @param timelock Block height after which the locked Ether can be refunded
    function refund(bytes32 preimageHash, uint256 amount, address claimAddress, address refundAddress, uint256 timelock)
        public
    {
        // Make sure the timelock has expired already
        // If the timelock is wrong, so will be the value hash of the swap which results in no swap being found
        require(timelock <= currentTime(), SwapNotTimedOut());
        refundInternal(preimageHash, amount, claimAddress, refundAddress, timelock);
    }

    /// Checks if a commitment signature is valid
    /// @param preimageHash Preimage hash of the swap
    /// @param amount Amount the swap has locked in WEI
    /// @param claimAddress Address that can claim the locked Ether
    /// @param refundAddress Address that locked the Ether and can refund them
    /// @param timelock Block height after which the locked Ether can be refunded
    /// @param v Final byte of the signature
    /// @param r Second 32 bytes of the signature
    /// @param s First 32 bytes of the signature
    /// @return True if the signature is valid, false otherwise
    function checkCommitmentSignature(
        bytes32 preimageHash,
        uint256 amount,
        address claimAddress,
        address refundAddress,
        uint256 timelock,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public view returns (bool) {
        address recoveredAddress = ecrecover(
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    DOMAIN_SEPARATOR,
                    keccak256(abi.encode(TYPEHASH_COMMIT, preimageHash, amount, claimAddress, refundAddress, timelock))
                )
            ),
            v,
            r,
            s
        );
        return recoveredAddress == refundAddress;
    }

    /// Hashes all the values of a swap with Keccak256
    /// @param preimageHash Preimage hash of the swap
    /// @param amount Amount the swap has locked in WEI
    /// @param claimAddress Address that can claim the locked Ether
    /// @param refundAddress Address that locked the Ether and can refund them
    /// @param timelock Block height after which the locked Ether can be refunded
    /// @return result Value hash of the swap
    function hashValues(
        bytes32 preimageHash,
        uint256 amount,
        address claimAddress,
        address refundAddress,
        uint256 timelock
    ) public pure returns (bytes32 result) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, preimageHash)
            mstore(add(ptr, 0x20), amount)
            mstore(add(ptr, 0x40), claimAddress)
            mstore(add(ptr, 0x60), refundAddress)
            mstore(add(ptr, 0x80), timelock)
            result := keccak256(ptr, 0xa0)
        }
    }

    // Private functions

    /// Prepares a claim from commited funds by checking if funds were locked, deleting the commitment from storage
    /// and emitting an event but ***does not*** transfer
    /// @notice Use this for commitment swaps where preimageHash was bytes32(0) during lock
    /// @notice Ensures the signature is from the refundAddress to authorize the claim
    /// @param preimage Preimage of the swap
    /// @param amount Amount locked in the contract for the swap in WEI
    /// @param claimAddress Address that that was destined to claim the funds
    /// @param refundAddress Address that locked the Ether and can refund them
    /// @param timelock Block height after which the locked Ether can be refunded
    /// @param v Final byte of the signature
    /// @param r Second 32 bytes of the signature
    /// @param s First 32 bytes of the signature
    function prepareCommitmentClaim(
        bytes32 preimage,
        uint256 amount,
        address claimAddress,
        address refundAddress,
        uint256 timelock,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        // Commitments are to bytes32(0)
        bytes32 hash = hashValues(bytes32(0), amount, claimAddress, refundAddress, timelock);

        // Make sure that the commitment to be claimed has Ether locked
        checkSwapIsLocked(hash);

        // If the preimage is wrong, so will be its hash which results in an invalid signature
        bytes32 preimageHash = sha256(abi.encodePacked(preimage));
        require(
            checkCommitmentSignature(preimageHash, amount, claimAddress, refundAddress, timelock, v, r, s),
            InvalidSignature()
        );

        // Delete the swap from the mapping to ensure that it cannot be claimed or refunded anymore
        // This *HAS* to be done before actually sending the Ether to avoid reentrancy
        delete swaps[hash];

        // Emit the claim event
        emit Claim(preimageHash, preimage);
    }

    /// Prepares a claim by checking if funds were locked, deleting the swap from storage
    /// and emitting an event but ***does not*** transfer
    /// @notice Reverts if preimageHash is bytes32(0), as that indicates a commitment which must be claimed via prepareCommitmentClaim
    /// @param preimage Preimage of the swap
    /// @param amount Amount locked in the contract for the swap in WEI
    /// @param claimAddress Address that that was destined to claim the funds
    /// @param refundAddress Address that locked the Ether and can refund them
    /// @param timelock Block height after which the locked Ether can be refunded
    function prepareClaim(
        bytes32 preimage,
        uint256 amount,
        address claimAddress,
        address refundAddress,
        uint256 timelock
    ) private {
        // If the preimage is wrong, so will be its hash which will result in a wrong value hash and no swap being found
        bytes32 preimageHash = sha256(abi.encodePacked(preimage));

        // Commitments are to bytes32(0) and can only be claimed as commitment
        require(preimageHash != bytes32(0), CommitmentCannotBeClaimedAsSwap());

        bytes32 hash = hashValues(preimageHash, amount, claimAddress, refundAddress, timelock);

        // Make sure that the swap to be claimed has Ether locked
        checkSwapIsLocked(hash);

        // Delete the swap from the mapping to ensure that it cannot be claimed or refunded anymore
        // This *HAS* to be done before actually sending the Ether to avoid reentrancy
        delete swaps[hash];

        // Emit the claim event
        emit Claim(preimageHash, preimage);
    }

    /// Locks Ether in the contract
    /// @param preimageHash Preimage hash of the swap
    /// @param amount Amount to be locked in the contract
    /// @param claimAddress Address that can claim the locked Ether
    /// @param refundAddress Address that can refund the locked Ether
    /// @param timelock Block height after which the locked Ether can be refunded
    function lockEther(
        bytes32 preimageHash,
        uint256 amount,
        address claimAddress,
        address refundAddress,
        uint256 timelock
    ) private {
        // Locking zero WEI in the contract is pointless
        require(amount > 0, ZeroAmount());

        // Hash the values of the swap
        bytes32 hash = hashValues(preimageHash, amount, claimAddress, refundAddress, timelock);

        // Make sure no swap with this value hash exists yet
        require(!swaps[hash], SwapAlreadyExists());

        // Save to the state that funds were locked for this swap
        swaps[hash] = true;

        // Emit the "Lockup" event
        emit Lockup(preimageHash, amount, claimAddress, refundAddress, timelock);
    }

    function refundInternal(
        bytes32 preimageHash,
        uint256 amount,
        address claimAddress,
        address refundAddress,
        uint256 timelock
    ) private {
        bytes32 hash = hashValues(preimageHash, amount, claimAddress, refundAddress, timelock);

        checkSwapIsLocked(hash);
        delete swaps[hash];

        emit Refund(preimageHash);

        TransferHelper.transferEther(payable(refundAddress), amount);
    }

    /// Checks whether a swap has Ether locked in the contract
    /// @dev This function reverts if the swap has no Ether locked in the contract
    /// @param hash Value hash of the swap
    function checkSwapIsLocked(bytes32 hash) private view {
        require(swaps[hash], SwapNotFound());
    }

    function currentTime() internal view virtual returns (uint256) {
        return block.number;
    }
}
