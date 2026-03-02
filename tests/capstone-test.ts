import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CapstoneTest } from "../target/types/capstone_test";
import { expect } from "chai";

describe("escrow-time-locked-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CapstoneTest as Program<CapstoneTest>;

  // Person A = owner/sender (provider wallet)
  const owner = provider.wallet as anchor.Wallet;

  // Person B = receiver (separate keypair)
  const receiver = anchor.web3.Keypair.generate();

  // Person C = unauthorized user (to test rejection)
  const unauthorized = anchor.web3.Keypair.generate();

  // Derive PDAs from owner's public key
  const [vaultStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_state"), owner.publicKey.toBuffer()],
    program.programId
  );
  const [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer()],
    program.programId
  );

  // Fund receiver and unauthorized wallets before tests
  before(async () => {
    console.log("\n   Test Setup:");
    console.log("  Person A (owner):       ", owner.publicKey.toString());
    console.log("  Person B (receiver):    ", receiver.publicKey.toString());
    console.log("  Person C (unauthorized):", unauthorized.publicKey.toString());

    // // Airdrop to receiver so they can pay tx fees
    // const receiverSig = await provider.connection.requestAirdrop(
    //   receiver.publicKey,
    //   0.5 * anchor.web3.LAMPORTS_PER_SOL
    // );
    // await provider.connection.confirmTransaction(receiverSig);

    // // Airdrop to unauthorized
    // const unauthorizedSig = await provider.connection.requestAirdrop(
    //   unauthorized.publicKey,
    //   0.5 * anchor.web3.LAMPORTS_PER_SOL
    // );
    // await provider.connection.confirmTransaction(unauthorizedSig);

    // Transfer from owner to receiver instead of airdropping
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: receiver.publicKey,
          lamports: 0.1 * anchor.web3.LAMPORTS_PER_SOL,
        })
      )
    );

    // Transfer from owner to unauthorized
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: unauthorized.publicKey,
          lamports: 0.1 * anchor.web3.LAMPORTS_PER_SOL,
        })
      )
    );

    console.log("   Receiver and unauthorized wallets funded\n");
  });

  // ─────────────────────────────────────────────
  // TEST 1: Initialize
  // ─────────────────────────────────────────────
  it("Person A initializes escrow vault naming Person B as receiver with 5s lock", async () => {
    const lockDuration = new anchor.BN(5);

    await program.methods
      .initialize(lockDuration, receiver.publicKey)
      .accounts({ owner: owner.publicKey })
      .rpc();

    const state = await program.account.vaultState.fetch(vaultStatePDA);

    console.log("  Owner (Person A):   ", state.owner.toString());
    console.log("  Receiver (Person B):", state.receiver.toString());
    console.log("  Lock until:         ", new Date(state.lockUntil.toNumber() * 1000).toISOString());
    console.log("  Is cancelled:       ", state.isCancelled);

    expect(state.owner.toString()).to.equal(owner.publicKey.toString());
    expect(state.receiver.toString()).to.equal(receiver.publicKey.toString());
    expect(state.lockUntil.toNumber()).to.be.greaterThan(0);
    expect(state.isCancelled).to.equal(false);
    expect(state.totalDeposited.toNumber()).to.equal(0);
  });

  // ─────────────────────────────────────────────
  // TEST 2: Owner cannot be receiver
  // ─────────────────────────────────────────────
  it("Fails if owner tries to set themselves as receiver", async () => {
    // Use a fresh keypair as owner for this test to avoid PDA conflict
    // const tempOwner = anchor.web3.Keypair.generate();
    // const sig = await provider.connection.requestAirdrop(
    //   tempOwner.publicKey,
    //   anchor.web3.LAMPORTS_PER_SOL
    // );
    // await provider.connection.confirmTransaction(sig);

    const tempOwner = anchor.web3.Keypair.generate();
    
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: tempOwner.publicKey,
          lamports: 0.1 * anchor.web3.LAMPORTS_PER_SOL,
        })
      )
    );
    try {
      await program.methods
        .initialize(new anchor.BN(5), tempOwner.publicKey)
        .accounts({ owner: tempOwner.publicKey })
        .signers([tempOwner])
        .rpc();
      expect.fail("Should have been rejected!");
    } catch (err: any) {
      console.log("   Correctly rejected:", err.message);
      expect(err.message).to.include("Receiver cannot be the same as owner");
    }
  });

  // ─────────────────────────────────────────────
  // TEST 3: Deposit
  // ─────────────────────────────────────────────
  it("Person A deposits 1 SOL into the escrow vault", async () => {
    const depositAmount = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL);
    const vaultBalanceBefore = await provider.connection.getBalance(vaultPDA);

    await program.methods
      .deposit(depositAmount)
      .accounts({ owner: owner.publicKey })
      .rpc();

    const vaultBalanceAfter = await provider.connection.getBalance(vaultPDA);
    const state = await program.account.vaultState.fetch(vaultStatePDA);

    console.log("  Vault balance after deposit:", vaultBalanceAfter / anchor.web3.LAMPORTS_PER_SOL, "SOL");
    console.log("  Total deposited recorded:   ", state.totalDeposited.toNumber() / anchor.web3.LAMPORTS_PER_SOL, "SOL");

    expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(anchor.web3.LAMPORTS_PER_SOL);
    expect(state.totalDeposited.toNumber()).to.equal(anchor.web3.LAMPORTS_PER_SOL);
  });

  // ─────────────────────────────────────────────
  // TEST 4: Person B cannot withdraw before lock
  // ─────────────────────────────────────────────
  it("Person B cannot withdraw before lock expires", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          receiver: receiver.publicKey,
          vaultState: vaultStatePDA,
        })
        .signers([receiver])
        .rpc();
      expect.fail("Should have been blocked!");
    } catch (err: any) {
      console.log("   Correctly blocked early withdrawal:", err.message);
      expect(err.message).to.include("vault is still locked");
    }
  });

  // ─────────────────────────────────────────────
  // TEST 5: Person A (owner) cannot withdraw
  // ─────────────────────────────────────────────
  it("Person A (owner) cannot withdraw — only Person B can", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          receiver: owner.publicKey,
          vaultState: vaultStatePDA,
        })
        .rpc();
      expect.fail("Should have been blocked!");
    } catch (err: any) {
      console.log("   Correctly blocked owner withdrawal:", err.message);
      expect(err.message).to.include("designated receiver");
    }
  });

  // ─────────────────────────────────────────────
  // TEST 6: Unauthorized user cannot withdraw
  // ─────────────────────────────────────────────
  it("Person C (unauthorized) cannot withdraw", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          receiver: unauthorized.publicKey,
          vaultState: vaultStatePDA,
        })
        .signers([unauthorized])
        .rpc();
      expect.fail("Should have been blocked!");
    } catch (err: any) {
      console.log("   Correctly blocked unauthorized withdrawal:", err.message);
      expect(err.message).to.include("designated receiver");
    }
  });

  // ─────────────────────────────────────────────
  // TEST 7: Person B withdraws after lock expires
  // ─────────────────────────────────────────────
  it("Person B withdraws successfully after lock expires", async () => {
    console.log("   Waiting 6 seconds for lock to expire...");
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const receiverBalanceBefore = await provider.connection.getBalance(receiver.publicKey);
    const vaultBalanceBefore    = await provider.connection.getBalance(vaultPDA);

    await program.methods
      .withdraw()
      .accounts({
        receiver: receiver.publicKey,
        vaultState: vaultStatePDA,
      })
      .signers([receiver])
      .rpc();

    const vaultBalanceAfter    = await provider.connection.getBalance(vaultPDA);
    const receiverBalanceAfter = await provider.connection.getBalance(receiver.publicKey);

    console.log("  Vault balance after withdrawal:", vaultBalanceAfter, "lamports");
    console.log(
      "  Person B received:",
      (receiverBalanceAfter - receiverBalanceBefore) / anchor.web3.LAMPORTS_PER_SOL,
      "SOL"
    );

    expect(vaultBalanceAfter).to.equal(0);
    expect(receiverBalanceAfter).to.be.greaterThan(receiverBalanceBefore);
  });

  // ─────────────────────────────────────────────
  // TEST 8: Cannot withdraw from empty vault
  // ─────────────────────────────────────────────
  it("Fails to withdraw from already emptied vault", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          receiver: receiver.publicKey,
          vaultState: vaultStatePDA,
        })
        .signers([receiver])
        .rpc();
      expect.fail("Should have failed!");
    } catch (err: any) {
      console.log("   Correctly rejected empty vault:", err.message);
      expect(err.message).to.include("no funds");
    }
  });

  // ─────────────────────────────────────────────
  // TEST 9: Close vault and recover rent
  // ─────────────────────────────────────────────
  it("Person A closes the vault state and recovers rent", async () => {
    const ownerBalanceBefore = await provider.connection.getBalance(owner.publicKey);

    await program.methods
      .closeVault()
      .accounts({ owner: owner.publicKey })
      .rpc();

    const ownerBalanceAfter = await provider.connection.getBalance(owner.publicKey);

    console.log(
      "  Rent recovered:",
      (ownerBalanceAfter - ownerBalanceBefore) / anchor.web3.LAMPORTS_PER_SOL,
      "SOL"
    );

    expect(ownerBalanceAfter).to.be.greaterThan(ownerBalanceBefore);

    // Verify account is gone
    try {
      await program.account.vaultState.fetch(vaultStatePDA);
      expect.fail("Account should be closed!");
    } catch {
      console.log("   VaultState account successfully closed");
    }
  });
});
