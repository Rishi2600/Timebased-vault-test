# Escrow Time-Locked Vault

A Solana smart contract built with the Anchor framework that acts as an **escrow vault with a time lock**. Person A locks funds for Person B, but Person B can only claim them after a fixed duration. Person A can cancel and recover funds — but only before the lock expires.

---

## Program ID (Devnet)

```
DmqR3zHzejgiUxr1TT5vmD3b4qB6n4NMPUiHNeskDvCy
```

View on Solana Explorer:
https://explorer.solana.com/address/DmqR3zHzejgiUxr1TT5vmD3b4qB6n4NMPUiHNeskDvCy?cluster=devnet

---

## Passing Tests

```
  escrow-time-locked-vault

  Test Setup:
  Person A (owner):        8KnvCVMvfBBaNGHHpF34kEVhAsoK2TYkWymvP5b8sBYW
  Person B (receiver):     5MsL54eBf59gVzH6ZDxXHTrLxAttAMCjmjtbDjoT6WG3
  Person C (unauthorized): 28Wr3L4Nv7NSrF4yGqFHJf5UWwZBzWhs4heUcoshFsZx
  Receiver and unauthorized wallets funded

    Person A initializes escrow vault naming Person B as receiver with 5s lock
    Fails if owner tries to set themselves as receiver
    Person A deposits 1 SOL into the escrow vault
    Person B cannot withdraw before lock expires
    Person A (owner) cannot withdraw — only Person B can
    Person C (unauthorized) cannot withdraw
    Person B withdraws successfully after lock expires
    Fails to withdraw from already emptied vault
    Person A closes the vault state and recovers rent

  9 passing
```

---

## What This Program Does

Think of this as a **time-locked safety deposit box** on the Solana blockchain with two keyholders:

- **Person A (Owner)** — puts money in and names the recipient
- **Person B (Receiver)** — the only one who can take the money out, but only after the timer expires

Neither person can cheat the system. The blockchain enforces every rule automatically — no middleman needed.

### Real World Use Cases

- **Salary vesting** — lock employee compensation that releases after a period
- **Escrow payments** — send payment to a contractor that releases on a deadline
- **Time-delayed gifts** — lock funds for someone that they can claim after a date
- **Conditional payments** — release funds to a receiver after a project deadline passes
- **Trust funds** — lock funds for a beneficiary until a certain time

---

## The Unique Constraints

This program enforces **two constraints simultaneously** on withdrawal:

### Constraint 1 — Only The Receiver Can Withdraw
```rust
constraint = vault_state.receiver == receiver.key() @ VaultError::UnauthorizedReceiver
```
Only the wallet address that Person A named at initialization can ever withdraw. Not Person A, not anyone else — only Person B.

### Constraint 2 — Only After Lock Expires
```rust
constraint = Clock::get().unwrap().unix_timestamp >= vault_state.lock_until @ VaultError::VaultStillLocked
```
Even Person B cannot withdraw before the timer runs out. The blockchain's on-chain clock is checked — there is no way to bypass this.

### Constraint 3 — Cancel Only Before Lock Expires
Person A can cancel and recover funds, but **only before** the lock expires:
```rust
require!(
    current_time < vault_state.lock_until,
    VaultError::CannotCancelAfterUnlock
);
```
Once the lock expires, the funds belong to Person B to claim. Person A loses the ability to cancel.

---

## Full Flow

```
Person A                                    Person B
    |                                           |
    |-- initialize(duration, PersonB.pubkey) -->| stored in VaultState
    |-- deposit(1 SOL) ----------------------- | vault PDA holds SOL
    |                                           |
    |        <- lock active ->                  |
    |                                           |
    |  (can cancel here to get funds back)      |-- withdraw() -> FAIL: VaultStillLocked
    |                                           |
    |        <- lock expires ->                 |
    |                                           |
    |  (cancel no longer possible)              |-- withdraw() -> OK: receives SOL
    |                                           |
    |-- closeVault() -------------------------- | rent returned to Person A
```

---

## Project Structure

```
capstone-test/
├── programs/
│   └── capstone-test/
│       └── src/
│           └── lib.rs              <- The vault program (Rust/Anchor)
├── tests/
│   └── capstone-test.ts            <- Full test suite (TypeScript)
├── scripts/
│   └── use-vault.ts                <- Real usage demo script
├── Anchor.toml                     <- Anchor config
├── Cargo.toml                      <- Rust dependencies
└── package.json                    <- Node dependencies
```

---

## Architecture — PDAs

Two PDAs are used, both derived from the **owner's public key**:

| PDA | Seeds | Type | Purpose |
|---|---|---|---|
| `vault_state` | `["vault_state", owner_pubkey]` | `Account<VaultState>` | Stores all metadata |
| `vault` | `["vault", owner_pubkey]` | `SystemAccount` | Physically holds the SOL |

### Why Two PDAs?
- `vault_state` is an Anchor account with typed fields (owner, receiver, timestamps etc.)
- `vault` is a plain system account that purely holds lamports — cleaner separation of state and funds
- Only the program can sign for both — no private key exists, making them trustless

---

## Instructions

### `initialize(lock_duration: i64, receiver: Pubkey)`
Person A creates the escrow vault, names Person B, and sets the lock duration.

```
lock_until = current_unix_timestamp + lock_duration
```

| Parameter | Type | Description |
|---|---|---|
| `lock_duration` | `i64` | Seconds to lock from now |
| `receiver` | `Pubkey` | Person B's wallet address |

**Guards:**
- Lock duration must be > 0
- Receiver cannot be the same as owner

---

### `deposit(amount: u64)`
Person A sends SOL into the vault. Can be called multiple times to add more funds.

| Parameter | Type | Description |
|---|---|---|
| `amount` | `u64` | Amount in lamports (1 SOL = 1,000,000,000) |

---

### `withdraw()`
Person B claims all SOL from the vault after the lock expires.

**Guards (all three must pass):**
- Caller must be the designated receiver
- Escrow must not be cancelled
- Current time must be >= `lock_until`

---

### `cancel()`
Person A cancels the escrow and recovers all funds.

**Guards:**
- Only the owner can call this
- Current time must be < `lock_until` (cannot cancel after unlock)

---

### `close_vault()`
Person A closes the `vault_state` account after the escrow is done, recovering the rent lamports.

---

## State — VaultState Account

```rust
pub struct VaultState {
    pub owner:           Pubkey,  // Person A — who created the escrow
    pub receiver:        Pubkey,  // Person B — who can claim the funds
    pub lock_until:      i64,     // Unix timestamp when funds unlock
    pub total_deposited: u64,     // Total lamports deposited
    pub is_cancelled:    bool,    // Whether escrow was cancelled
    pub bump:            u8,      // PDA bump for vault_state
    pub vault_bump:      u8,      // PDA bump for vault
}
```

**Account size:** 8 + 32 + 32 + 8 + 8 + 1 + 1 + 1 = **91 bytes**

---

## Errors

| Error | When It's Thrown |
|---|---|
| `VaultStillLocked` | Withdraw called before `lock_until` |
| `UnauthorizedReceiver` | Caller is not the designated receiver |
| `CannotCancelAfterUnlock` | Cancel called after lock has expired |
| `InvalidAmount` | Deposit amount is zero |
| `InvalidLockDuration` | Lock duration is zero or negative |
| `VaultEmpty` | Withdraw or cancel called on empty vault |
| `EscrowCancelled` | Action called after escrow was cancelled |
| `ReceiverCannotBeOwner` | Owner tried to name themselves as receiver |

---

## Test Suite — 9 Tests

| # | Test | What It Proves |
|---|---|---|
| 1 | Initialize with 5s lock | Vault creates with correct owner, receiver, timestamp |
| 2 | Owner cannot be receiver | Safety guard works |
| 3 | Deposit 1 SOL | Funds move into vault correctly |
| 4 | Person B blocked before lock | Time constraint works |
| 5 | Person A blocked from withdrawing | Receiver constraint works |
| 6 | Person C blocked from withdrawing | Unauthorized access blocked |
| 7 | Person B withdraws after lock | Full happy path works |
| 8 | Empty vault blocked | Cannot double withdraw |
| 9 | Close vault recovers rent | Cleanup works, rent returned |

---

## Setup & Running

### Prerequisites
- Rust + Cargo
- Solana CLI
- Anchor CLI
- Node.js + Yarn

### Install
```bash
git clone <your-repo-url>
cd capstone-test
yarn install
```

### Build
```bash
anchor build
```

### Test Locally
```bash
anchor test
```

### Deploy to Devnet
```bash
# Fund your wallet first at faucet.solana.com
# Update Anchor.toml cluster to devnet, then:
anchor deploy
anchor test --skip-local-validator --skip-deploy
```

### Run Demo Script
```bash
# Create .env file with:
# ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
# ANCHOR_WALLET=/path/to/your/wallet.json

npx ts-node scripts/test-vault.ts
```

---

## Built With

- [Anchor Framework](https://www.anchor-lang.com/) — Solana smart contract framework
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/) — Client interactions
- [Mocha](https://mochajs.org/) + [Chai](https://www.chaijs.com/) — Test framework
- TypeScript — Tests and scripts

---

## Key Design Decisions

**Why are constraints on the struct instead of in the function?**
The `Withdraw` context uses `constraint` annotations directly on the account struct instead of `require!` macros in the function body. This avoids a circular PDA resolution dependency — Anchor cannot derive `vault_state` from `vault_state.owner` seeds because it needs `vault_state` to get `vault_state.owner`. Moving checks to constraints and passing `vaultState` explicitly breaks the cycle cleanly.

**Why can Person A cancel only before the lock?**
Once the lock expires, the funds are considered owed to Person B. Allowing Person A to cancel after expiry would let them steal funds that Person B is entitled to claim.

**Why does `vault` use `vault_state.owner` in its seeds during withdraw?**
By the time `vault` is resolved, `vault_state` has already been loaded since it is passed explicitly. So `vault_state.owner` is available and there is no circular dependency for the `vault` PDA — only `vault_state` had the issue.