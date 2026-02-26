import * as anchor from "@coral-xyz/anchor";
import { Program }  from "@coral-xyz/anchor";
import { CapstoneTest } from "../target/types/capstone_test";
import { expect }   from "chai";

describe("time-locked-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CapstoneTest as Program<CapstoneTest>;
  const owner   = provider.wallet as anchor.Wallet;

  // Derive PDAs
  const [vaultStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_state"), owner.publicKey.toBuffer()],
    program.programId
  );
  const [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer()],
    program.programId
  );


  //test-1
  it("Initializes the vault with a 5-second lock", async () => {
    const lockDuration = new anchor.BN(5); // 5 seconds for testing

    await program.methods
      .initialize(lockDuration)
      .accounts({
        owner: owner.publicKey,
      })
      .rpc();

    const state = await program.account.vaultState.fetch(vaultStatePDA);
    console.log("  Lock until:", new Date(state.lockUntil.toNumber() * 1000).toISOString());

    expect(state.owner.toString()).to.equal(owner.publicKey.toString());
    expect(state.lockUntil.toNumber()).to.be.greaterThan(0);
    expect(state.totalDeposited.toNumber()).to.equal(0);
  });


  //test-2
  it("Deposits 1 SOL into the vault", async () => {
    const depositAmount = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL); // 1 SOL

    const vaultBalanceBefore = await provider.connection.getBalance(vaultPDA);

    await program.methods
      .deposit(depositAmount)
      .accounts({
        owner: owner.publicKey,
      })
      .rpc();

    const vaultBalanceAfter = await provider.connection.getBalance(vaultPDA);
    const state = await program.account.vaultState.fetch(vaultStatePDA);

    console.log("  Vault balance after deposit:", vaultBalanceAfter / anchor.web3.LAMPORTS_PER_SOL, "SOL");

    expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(anchor.web3.LAMPORTS_PER_SOL);
    expect(state.totalDeposited.toNumber()).to.equal(anchor.web3.LAMPORTS_PER_SOL);
  });


  //test-3
  it("Fails to withdraw before the lock period ends", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          owner: owner.publicKey,
        })
        .rpc();

      // Should never reach here
      expect.fail("Withdrawal should have been rejected!");
    } catch (err: any) {
      console.log(" Correctly rejected early withdrawal:", err.error?.errorMessage);
      expect(err.error.errorMessage).to.include("vault is still locked");
    }
  });


  //test-4
  it("Withdraws successfully after lock period expires", async () => {
    // Wait 6 seconds for the 5-second lock to expire
    console.log("  Waiting 6 seconds for lock to expire...");
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const ownerBalanceBefore = await provider.connection.getBalance(owner.publicKey);
    const vaultBalanceBefore = await provider.connection.getBalance(vaultPDA);

    await program.methods
      .withdraw()
      .accounts({
        owner: owner.publicKey,
      })
      .rpc();

    const vaultBalanceAfter = await provider.connection.getBalance(vaultPDA);
    const ownerBalanceAfter  = await provider.connection.getBalance(owner.publicKey);

    console.log("  Vault balance after withdrawal:", vaultBalanceAfter, "lamports");
    console.log("  Owner received ~", (ownerBalanceAfter - ownerBalanceBefore) / anchor.web3.LAMPORTS_PER_SOL, "SOL");

    expect(vaultBalanceAfter).to.equal(0);
    expect(ownerBalanceAfter).to.be.greaterThan(ownerBalanceBefore);
  });


  //test-5
  it("Fails to withdraw from an already emptied vault", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          owner: owner.publicKey,
        })
        .rpc();

      expect.fail("Should have failed on empty vault!");
    } catch (err: any) {
      console.log("  Correctly rejected empty vault withdrawal:", err.error?.errorMessage);
      expect(err.error.errorMessage).to.include("no funds");
    }
  });
});