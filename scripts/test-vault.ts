import * as dotenv from "dotenv";
dotenv.config();

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CapstoneTest } from "../target/types/capstone_test";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CapstoneTest as Program<CapstoneTest>;

  // Person A = whoever's wallet is in ANCHOR_WALLET env
  const owner = provider.wallet as anchor.Wallet;

  // Person B = a new keypair (in real life this would be a different person's wallet)
  const receiver = anchor.web3.Keypair.generate();

  console.log("\n════════════════════════════════════════");
  console.log("   ⏰ Escrow Time-Locked Vault Demo");
  console.log("════════════════════════════════════════");
  console.log("Person A (owner):   ", owner.publicKey.toString());
  console.log("Person B (receiver):", receiver.publicKey.toString());
  console.log("Program ID:         ", program.programId.toString());

  // Derive PDAs
  const [vaultStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_state"), owner.publicKey.toBuffer()],
    program.programId
  );
  const [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer()],
    program.programId
  );

  console.log("\nVault State PDA:", vaultStatePDA.toString());
  console.log("Vault PDA:      ", vaultPDA.toString());

  // ─────────────────────────────────────────────
  // STEP 1: Fund receiver with some SOL for tx fees
  // ─────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("STEP 1: Funding Person B for tx fees...");
  const airdropSig = await provider.connection.requestAirdrop(
    receiver.publicKey,
    0.1 * anchor.web3.LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(airdropSig);
  console.log("✅ Person B funded with 0.1 SOL for fees");

  // ─────────────────────────────────────────────
  // STEP 2: Initialize escrow vault
  // ─────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("STEP 2: Person A initializes escrow vault...");
  console.log("Lock duration: 15 seconds");

  const lockDuration = new anchor.BN(15);

  await program.methods
    .initialize(lockDuration, receiver.publicKey)
    .accounts({ owner: owner.publicKey })
    .rpc();

  const stateAfterInit = await program.account.vaultState.fetch(vaultStatePDA);
  const unlockTime = new Date(stateAfterInit.lockUntil.toNumber() * 1000);
  console.log("✅ Vault initialized!");
  console.log("   Unlocks at:", unlockTime.toLocaleString());

  // ─────────────────────────────────────────────
  // STEP 3: Person A deposits SOL
  // ─────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("STEP 3: Person A deposits 0.2 SOL into vault...");

  await program.methods
    .deposit(new anchor.BN(0.2 * anchor.web3.LAMPORTS_PER_SOL))
    .accounts({ owner: owner.publicKey })
    .rpc();

  const vaultBalance = await provider.connection.getBalance(vaultPDA);
  console.log("✅ Deposited! Vault balance:", vaultBalance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

  // ─────────────────────────────────────────────
  // STEP 4: Person B tries to withdraw early (will fail)
  // ─────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("STEP 4: Person B tries to withdraw early...");

  try {
    await program.methods
      .withdraw()
      .accounts({
        receiver: receiver.publicKey,
      })
      .signers([receiver])
      .rpc();
    console.log("❌ This should not have worked!");
  } catch (err: any) {
    console.log("✅ Correctly blocked! Reason:", err.error?.errorMessage);
  }

  // ─────────────────────────────────────────────
  // STEP 5: Person A tries to withdraw (will fail — not the receiver)
  // ─────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("STEP 5: Person A tries to withdraw (they can't — only Person B can)...");

  try {
    await program.methods
      .withdraw()
      .accounts({
        receiver: owner.publicKey,
      })
      .rpc();
    console.log("❌ This should not have worked!");
  } catch (err: any) {
    console.log("✅ Correctly blocked! Reason:", err.error?.errorMessage);
  }

  // ─────────────────────────────────────────────
  // STEP 6: Wait for lock to expire
  // ─────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("STEP 6: Waiting 16 seconds for lock to expire...");

  for (let i = 16; i > 0; i--) {
    process.stdout.write(`\r   ⏳ ${i} seconds remaining...`);
    await sleep(1000);
  }
  console.log("\n✅ Lock has expired!");

  // ─────────────────────────────────────────────
  // STEP 7: Person B successfully withdraws
  // ─────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("STEP 7: Person B withdraws after lock expires...");

  const receiverBalanceBefore = await provider.connection.getBalance(receiver.publicKey);

  await program.methods
    .withdraw()
    .accounts({
      receiver: receiver.publicKey,
    })
    .signers([receiver])
    .rpc();

  const receiverBalanceAfter = await provider.connection.getBalance(receiver.publicKey);
  const vaultBalanceAfter    = await provider.connection.getBalance(vaultPDA);

  console.log("✅ Person B successfully withdrew!");
  console.log("   Vault balance now:", vaultBalanceAfter, "lamports");
  console.log(
    "   Person B received:",
    (receiverBalanceAfter - receiverBalanceBefore) / anchor.web3.LAMPORTS_PER_SOL,
    "SOL"
  );

  // ─────────────────────────────────────────────
  // STEP 8: Close vault and recover rent
  // ─────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("STEP 8: Person A closes vault and recovers rent...");

  const ownerBalanceBefore = await provider.connection.getBalance(owner.publicKey);

  await program.methods
    .closeVault()
    .accounts({ owner: owner.publicKey })
    .rpc();

  const ownerBalanceAfter = await provider.connection.getBalance(owner.publicKey);
  console.log("✅ Vault closed!");
  console.log(
    "   Rent recovered:",
    (ownerBalanceAfter - ownerBalanceBefore) / anchor.web3.LAMPORTS_PER_SOL,
    "SOL"
  );

  console.log("\n════════════════════════════════════════");
  console.log("   ✅ Escrow Demo Complete!");
  console.log("════════════════════════════════════════\n");
};

main().catch(console.error);
