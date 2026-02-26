use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("DmqR3zHzejgiUxr1TT5vmD3b4qB6n4NMPUiHNeskDvCy");

#[program]
pub mod capstone_test {
    use super::*;

    /// Creates the vault and sets the lock duration in seconds
    pub fn initialize(ctx: Context<Initialize>, lock_duration: i64) -> Result<()> {
        require!(lock_duration > 0, VaultError::InvalidLockDuration);

        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.owner       = ctx.accounts.owner.key();
        vault_state.lock_until  = Clock::get()?.unix_timestamp + lock_duration;
        vault_state.bump        = ctx.bumps.vault_state;
        vault_state.vault_bump  = ctx.bumps.vault;

        msg!(
            "Vault initialized! Funds locked until timestamp: {}",
            vault_state.lock_until
        );

        Ok(())
    }

    /// Deposit SOL into the vault
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

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

        msg!("Deposited {} lamports into the vault", amount);
        Ok(())
    }

    /// Withdraw all SOL — only allowed after the lock period expires
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;
        let vault_state  = &ctx.accounts.vault_state;

        // ✅ THE UNIQUE CONSTRAINT: time check
        require!(
            current_time >= vault_state.lock_until,
            VaultError::VaultStillLocked
        );

        // Drain the entire vault balance
        let vault_balance = ctx.accounts.vault.lamports();
        require!(vault_balance > 0, VaultError::VaultEmpty);

        // PDA signer seeds so the vault account can sign the transfer
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

        msg!(
            "Withdrawn {} lamports. Vault unlocked at: {}. Current time: {}",
            vault_balance,
            vault_state.lock_until,
            current_time
        );

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

    /// PDA that stores vault metadata
    #[account(
        init,
        payer  = owner,
        space  = VaultState::INIT_SPACE,
        seeds  = [b"vault_state", owner.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    /// PDA that physically holds the SOL
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

// ──────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────

#[account]
pub struct VaultState {
    pub owner:           Pubkey,  // 32
    pub lock_until:      i64,     // 8  — Unix timestamp when funds unlock
    pub total_deposited: u64,     // 8
    pub bump:            u8,      // 1
    pub vault_bump:      u8,      // 1
}

impl Space for VaultState {
    const INIT_SPACE: usize = 8 + 32 + 8 + 8 + 1 + 1; // discriminator + fields
}

// ──────────────────────────────────────────────
// ERRORS
// ──────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("The vault is still locked. Come back later!")]
    VaultStillLocked,

    #[msg("Deposit amount must be greater than zero")]
    InvalidAmount,

    #[msg("Lock duration must be greater than zero")]
    InvalidLockDuration,

    #[msg("The vault has no funds to withdraw")]
    VaultEmpty,
}