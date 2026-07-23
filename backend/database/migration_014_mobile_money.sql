-- Migration 014: Add account_type to bank_accounts for mobile money support
-- account_type: 'bank' (default) or 'mobile_money'
-- mobile_money_account_id in payments: links a mobile_money payment to a specific provider

ALTER TABLE bank_accounts
    ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) NOT NULL DEFAULT 'bank'
    CHECK (account_type IN ('bank', 'mobile_money'));

CREATE INDEX IF NOT EXISTS idx_bank_accounts_type ON bank_accounts(account_type);

-- Add mobile_money_account_id to payments table so we can track which provider was used
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS mobile_money_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payments_mobile_acct ON payments(mobile_money_account_id);

-- Existing bank_accounts stay as 'bank' (default applied above)
