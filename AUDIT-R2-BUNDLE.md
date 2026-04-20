# Darbitex Audit R2 Bundle Status

| ID | Finding | Status | Evidence |
|----|---------|--------|----------|
| **C-1** | `unlock_state()` hilang di `omni_swap_thala_twamm` | ✅ FIXED | `bridge.move:485`: `unlock_state();` ditambahkan sebelum penutup fungsi. |
| **C-2** | Thala arb-leg pakai `deadline=0` | ✅ FIXED | `bridge.move:181` & `bridge.move:442`: Menggunakan variabel `deadline`. |
| **H-1** | Oracle stale — tidak ada recovery | ✅ FIXED | `twamm.move:95-105`: `force_update_oracle` admin-gated ditambahkan. |
| **H-2** | 50% slippage window → DoS | ✅ FIXED | `twamm.move:225`: `min_out * 90/100` (lebih ketat dari sebelumnya `/2`). |
| **M-1** | Hyperion/Cellana TWAMM variants = dead code | ✅ FIXED | Fungsi `omni_swap_hyperion_twamm` & `omni_swap_cellana_twamm` telah dihapus dari `bridge.move`. |
| **M-2** | `init_ema_oracle` = public fun bukan entry | ✅ FIXED | `twamm.move:75`: Sekarang `public entry fun init_ema_oracle`. |
| **M-3** | EMA reserve_in beku — comment misleading | ✅ FIXED | `twamm.move:253-255`: Komentar diperjelas ("keep reserve_in fixed"). |
| **M-4** | Keeper signer unverified | ⚠️ N/A | Dicatat sebagai informational (bukan exploit). |
| **L-1** | Unused use `aptos_std::math128` | ✅ FIXED | Baris `use aptos_std::math128;` telah dihapus. |
| **L-2** | Aave 0-fee assumption | ⚠️ N/A | Catatan operasional, bukan bug kode. |
| **L-3** | Indentasi else branch leading-space | ✅ FIXED | Spasi ekstra pada `event::emit` di cabang `else` telah dihapus di seluruh `bridge.move`. |

## Source Code Updates
- **`flashbot/sources/bridge.move`**: Terupdate (487 lines).
- **`twamm/sources/twamm.move`**: Terupdate (294 lines).
