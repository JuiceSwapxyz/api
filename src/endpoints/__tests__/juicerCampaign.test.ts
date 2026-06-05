/**
 * Juicer NFT claim signature — contract compatibility tests.
 *
 * JuicerNFT.sol verifies:
 *   bytes32 messageHash = keccak256(abi.encodePacked(address(this), block.chainid, msg.sender));
 *   address recovered = messageHash.toEthSignedMessageHash().recover(signature);
 *   recovered == signer
 *
 * These tests re-derive the contract side with ethers primitives and assert
 * the backend helper produces a signature the contract would accept — the
 * single highest-risk invariant of the claim flow (a mismatch bricks every
 * claim with InvalidSignature, discoverable only on-chain).
 */

import { ethers } from "ethers";
import { buildJuicerClaimSignature } from "../juicerCampaign";

// Deterministic test-only key (hardhat account #0 — never used in prod).
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_SIGNER_ADDRESS = new ethers.Wallet(TEST_PRIVATE_KEY).address;

const CONTRACT = "0x428B878cB6383216AaDc4e8495037E8d31612621";
const CHAIN_ID = 4114;
const WALLET = "0x2f0cc51c02e5d4ec68bc155728798969d5c0f714"; // lowercase on purpose

describe("buildJuicerClaimSignature", () => {
  it("recovers to the signer for the contract's exact message hash", async () => {
    const signature = await buildJuicerClaimSignature(
      TEST_PRIVATE_KEY,
      CONTRACT,
      CHAIN_ID,
      WALLET,
    );

    // Contract side: keccak256(abi.encodePacked(contract, chainid, wallet)),
    // then EIP-191 ("\x19Ethereum Signed Message:\n32") before recover.
    const messageHash = ethers.utils.solidityKeccak256(
      ["address", "uint256", "address"],
      [CONTRACT, CHAIN_ID, WALLET],
    );
    const recovered = ethers.utils.verifyMessage(
      ethers.utils.arrayify(messageHash),
      signature,
    );

    expect(recovered).toBe(TEST_SIGNER_ADDRESS);
  });

  it("binds the signature to wallet, contract and chain (no cross-use)", async () => {
    const signature = await buildJuicerClaimSignature(
      TEST_PRIVATE_KEY,
      CONTRACT,
      CHAIN_ID,
      WALLET,
    );

    const recoverFor = (
      contract: string,
      chainId: number,
      wallet: string,
    ): string => {
      const hash = ethers.utils.solidityKeccak256(
        ["address", "uint256", "address"],
        [contract, chainId, wallet],
      );
      return ethers.utils.verifyMessage(ethers.utils.arrayify(hash), signature);
    };

    // A different wallet, contract, or chain must NOT recover to the signer —
    // otherwise one issued signature would mint for arbitrary callers.
    const otherWallet = "0x1111111111111111111111111111111111111111";
    const otherContract = "0x2222222222222222222222222222222222222222";
    expect(recoverFor(CONTRACT, CHAIN_ID, otherWallet)).not.toBe(
      TEST_SIGNER_ADDRESS,
    );
    expect(recoverFor(otherContract, CHAIN_ID, WALLET)).not.toBe(
      TEST_SIGNER_ADDRESS,
    );
    expect(recoverFor(CONTRACT, 5115, WALLET)).not.toBe(TEST_SIGNER_ADDRESS);
  });

  it("is case-insensitive over the wallet address (checksum == lowercase)", async () => {
    const sigLower = await buildJuicerClaimSignature(
      TEST_PRIVATE_KEY,
      CONTRACT,
      CHAIN_ID,
      WALLET.toLowerCase(),
    );
    const sigChecksum = await buildJuicerClaimSignature(
      TEST_PRIVATE_KEY,
      CONTRACT,
      CHAIN_ID,
      ethers.utils.getAddress(WALLET),
    );
    // solidityKeccak256 encodes the address as 20 raw bytes, so the textual
    // casing of the input must not change the signature.
    expect(sigLower).toBe(sigChecksum);
  });
});
