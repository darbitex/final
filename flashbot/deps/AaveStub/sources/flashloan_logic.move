/// Interface stub for `aave_pool::flashloan_logic`. Matches the
/// live on-chain module at address `aave_pool`. Bodies never execute
/// — the runtime linker routes calls to the real module.
///
/// ABI verified via REST /accounts/<addr>/module/flashloan_logic on
/// 2026-04-15 against mainnet. Exact return type is
/// `SimpleFlashLoansReceipt` (not `FlashLoanReceipt` — common mis-
/// naming). Fields don't need to match the real layout because the
/// satellite never reads them — the receipt flows through as an
/// opaque handle from `flash_loan_simple` to `pay_flash_loan_simple`.
module aave_pool::flashloan_logic {
    /// Hot-potato receipt. No abilities so it must be consumed by
    /// `pay_flash_loan_simple` in the same transaction. Layout is a
    /// placeholder — the real struct has richer fields.
    struct SimpleFlashLoansReceipt {
        _dummy: u64,
    }

    /// Borrow `amount` of `asset` from Aave. Deposits the borrowed FA
    /// to `on_behalf_of`'s primary fungible store. Returns a receipt
    /// that must be paid back in the same transaction. Aptos Aave
    /// charges 0 fee on `flash_loan_simple`.
    ///
    /// On-chain signature (verified):
    /// (&signer, address, address, u256, u16) → SimpleFlashLoansReceipt
    public fun flash_loan_simple(
        _user: &signer,
        _on_behalf_of: address,
        _asset: address,
        _amount: u256,
        _referral: u16,
    ): SimpleFlashLoansReceipt {
        abort 0
    }

    /// Repay the flash loan. Pulls `borrow_amount` back from `user`'s
    /// primary store and consumes the receipt.
    ///
    /// On-chain signature (verified):
    /// (&signer, SimpleFlashLoansReceipt) → ()
    public fun pay_flash_loan_simple(
        _user: &signer,
        _receipt: SimpleFlashLoansReceipt,
    ) {
        abort 0
    }
}
