use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("DmqR3zHzejgiUxr1TT5vmD3b4qB6n4NMPUiHNeskDvCy");

#[program]
pub mod capstone_test {
    use super::*;

    /// Person A creates the escrow vault and names Person B as receiver
    pub fn initialize(ctx: Context<Initialize>, lock_duration: i64, receiver: Pubkey) -> Result<()> {
        require!(lock_duration > 0, VaultError::InvalidLockDuration);
        require!(
            receiver != ctx.accounts.owner.key(),
            VaultError::ReceiverCannotBeOwner
        );

        let vault_state         = &mut ctx.accounts.vault_state;
        vault_state.owner       = ctx.accounts.owner.key();
        vault_state.receiver    = receiver;
        vault_state.lock_until  = Clock::get()?.unix_timestamp + lock_duration;
        vault_state.bump        = ctx.bumps.vault_state;
        vault_state.vault_bump  = ctx.bumps.vault;
        vault_state.total_deposited = 0;
        vault_state.is_cancelled = false;

        msg!("Escrow vault initialized!");
        msg!("Owner (Person A):    {}", vault_state.owner);
        msg!("Receiver (Person B): {}", vault_state.receiver);
        msg!("Locked until:        {}", vault_state.lock_until);

        Ok(())
    }

    /// Person A deposits SOL into the vault
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);
        require!(!ctx.accounts.vault_state.is_cancelled, VaultError::EscrowCancelled);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to:   ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        ctx.accounts.vault_state.total_deposited += amount;

        msg!("Person A deposited {} lamports", amount);
        msg!("Total in vault: {}", ctx.accounts.vault_state.total_deposited);

        Ok(())
    }

    /// Person B withdraws SOL — only after lock expires
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;
        let vault_state  = &ctx.accounts.vault_state;

        // Only designated receiver can withdraw
        require!(
            ctx.accounts.receiver.key() == vault_state.receiver,
            VaultError::UnauthorizedReceiver
        );

        // Escrow must not be cancelled
        require!(!vault_state.is_cancelled, VaultError::EscrowCancelled);

        // Time lock constraint
        require!(
            current_time >= vault_state.lock_until,
            VaultError::VaultStillLocked
        );

        let vault_balance = ctx.accounts.vault.lamports();
        require!(vault_balance > 0, VaultError::VaultEmpty);

        let owner_key = vault_state.owner;
        let seeds     = &[b"vault".as_ref(), owner_key.as_ref(), &[vault_state.vault_bump]];
        let signer    = &[&seeds[..]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to:   ctx.accounts.receiver.to_account_info(),
                },
                signer,
            ),
            vault_balance,
        )?;

        msg!(
            "Person B ({}) withdrew {} lamports after lock expired",
            ctx.accounts.receiver.key(),
            vault_balance
        );

        Ok(())
    }

    /// Person A cancels the escrow and gets funds back — only BEFORE lock expires
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;
        let vault_state  = &ctx.accounts.vault_state;

        // Can only cancel before lock expires
        require!(
            current_time < vault_state.lock_until,
            VaultError::CannotCancelAfterUnlock
        );

        require!(!vault_state.is_cancelled, VaultError::EscrowCancelled);

        let vault_balance = ctx.accounts.vault.lamports();
        require!(vault_balance > 0, VaultError::VaultEmpty);

        let owner_key = vault_state.owner;
        let seeds     = &[b"vault".as_ref(), owner_key.as_ref(), &[vault_state.vault_bump]];
        let signer    = &[&seeds[..]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to:   ctx.accounts.owner.to_account_info(),
                },
                signer,
            ),
            vault_balance,
        )?;

        ctx.accounts.vault_state.is_cancelled = true;

        msg!(
            "Escrow cancelled by owner {}. Funds returned.",
            ctx.accounts.owner.key()
        );

        Ok(())
    }

    /// Closes the vault_state account and returns rent to owner
    pub fn close_vault(_ctx: Context<CloseVault>) -> Result<()> {
        msg!("Vault state closed. Rent returned to owner.");
        Ok(())
    }
}

// ──────────────────────────────────────────────
// ACCOUNT CONTEXTS
// ──────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer  = owner,
        space  = VaultState::INIT_SPACE,
        seeds  = [b"vault_state", owner.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds  = [b"vault", owner.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds  = [b"vault_state", owner.key().as_ref()],
        bump   = vault_state.bump,
        has_one = owner,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds  = [b"vault", owner.key().as_ref()],
        bump   = vault_state.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub receiver: Signer<'info>,

    /// CHECK: Used for PDA derivation only
    pub owner: AccountInfo<'info>,

    #[account(
        mut,
        seeds  = [b"vault_state", owner.key().as_ref()],
        bump   = vault_state.bump,
        has_one = owner,  // verifies stored owner matches passed owner
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds  = [b"vault", owner.key().as_ref()],
        bump   = vault_state.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds  = [b"vault_state", owner.key().as_ref()],
        bump   = vault_state.bump,
        has_one = owner,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds  = [b"vault", owner.key().as_ref()],
        bump   = vault_state.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        close  = owner,
        seeds  = [b"vault_state", owner.key().as_ref()],
        bump   = vault_state.bump,
        has_one = owner,
    )]
    pub vault_state: Account<'info, VaultState>,

    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────

#[account]
pub struct VaultState {
    pub owner:           Pubkey,   // 32 — Person A
    pub receiver:        Pubkey,   // 32 — Person B
    pub lock_until:      i64,      // 8  — Unix timestamp when funds unlock
    pub total_deposited: u64,      // 8
    pub is_cancelled:    bool,     // 1
    pub bump:            u8,       // 1
    pub vault_bump:      u8,       // 1
}

impl Space for VaultState {
    const INIT_SPACE: usize = 8 + 32 + 32 + 8 + 8 + 1 + 1 + 1;
}

// ──────────────────────────────────────────────
// ERRORS
// ──────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("The vault is still locked. Come back later!")]
    VaultStillLocked,

    #[msg("Only the designated receiver can withdraw")]
    UnauthorizedReceiver,

    #[msg("Cannot cancel after the lock period has expired")]
    CannotCancelAfterUnlock,

    #[msg("Deposit amount must be greater than zero")]
    InvalidAmount,

    #[msg("Lock duration must be greater than zero")]
    InvalidLockDuration,

    #[msg("The vault has no funds to withdraw")]
    VaultEmpty,

    #[msg("This escrow has been cancelled")]
    EscrowCancelled,

    #[msg("Receiver cannot be the same as owner")]
    ReceiverCannotBeOwner,
}