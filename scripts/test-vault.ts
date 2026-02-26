import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CapstoneTest } from "../target/types/capstone_test"; 
import * as dotenv from "dotenv";

dotenv.config()

const main = async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CapstoneTest as Program<CapstoneTest>;
  const owner = provider.wallet as anchor.Wallet;

  const [vaultStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_state"), owner.publicKey.toBuffer()],
    program.programId
  );
  const [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer()],
    program.programId
  );

  // Lock for 60 seconds (real use: pass 86400 for 1 day)
  const lockDuration = new anchor.BN(60);

  console.log("🔐 Initializing vault with 60 second lock...");
  await program.methods
    .initialize(lockDuration)
    .accounts({ owner: owner.publicKey })
    .rpc();
  console.log("✅ Vault initialized!");

  console.log("💰 Depositing 0.5 SOL...");
  await program.methods
    .deposit(new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL))
    .accounts({ owner: owner.publicKey })
    .rpc();
  console.log("✅ Deposited!");

  // Check vault state
  const state = await program.account.vaultState.fetch(vaultStatePDA);
  const unlockTime = new Date(state.lockUntil.toNumber() * 1000);
  console.log(`⏰ Funds locked until: ${unlockTime.toLocaleString()}`);
  console.log(`💎 Total deposited: ${state.totalDeposited.toNumber() / anchor.web3.LAMPORTS_PER_SOL} SOL`);

  // Try withdrawing immediately (will fail)
  console.log("\n❌ Trying to withdraw early...");
  try {
    await program.methods
      .withdraw()
      .accounts({ owner: owner.publicKey })
      .rpc();
  } catch (err: any) {
    console.log("Blocked:", err.error.errorMessage);
  }

  // Wait for lock to expire
  console.log("\n⏳ Waiting 60 seconds for lock to expire...");
  await new Promise((resolve) => setTimeout(resolve, 61000));

  // Now withdraw
  console.log("💸 Withdrawing...");
  await program.methods
    .withdraw()
    .accounts({ owner: owner.publicKey })
    .rpc();
  console.log("✅ Successfully withdrawn!");
};

main().catch(console.error);