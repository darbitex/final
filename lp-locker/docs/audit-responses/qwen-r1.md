# Qwen — LP Locker R1 audit response

**Date:** 2026-04-16
**Verdict:** 🟢 **GREEN for mainnet publish readiness**
**Severity counts:** 0 HIGH / 0 MEDIUM / 1 LOW (gas optimization, non-blocking) / 3 INFO (no-fix)

---

## Findings

### LOW-1: Unnecessary gas cost from depositing zero-value FungibleAssets in `claim_fees`

**Location:** `lock.move:108-109`

**Description:** `pool::claim_lp_fees` returns `fungible_asset::zero(metadata)` when no fees have accrued. `claim_fees` unconditionally deposits both `fa_a` and `fa_b` via `primary_fungible_store::deposit`. While functionally harmless (Move's linear types guarantee consumption), depositing a zero-amount FA still incurs framework storage read/write overhead (~300-500 gas) and may initialize an empty primary store slot if one doesn't exist.

**Impact:** Minor gas inefficiency for users claiming fees in low-activity pools or shortly after prior claims.

**Recommended fix:** Wrap deposits in conditional guards:
```move
if (fees_a > 0) primary_fungible_store::deposit(user_addr, fa_a);
else fungible_asset::destroy_zero(fa_a);
```

### INFORMATIONAL-1: `redeem` destructure-before-assert relies on transactional atomicity

**Location:** `lock.move:118-120`

**Description:** The function destructures `LockedPosition` via `move_from` before asserting `now >= unlock_at`. If the time check fails, the transaction aborts. Move's execution model guarantees full state rollback.

**Impact:** None. Idiomatic Move, explicitly safe under Aptos VM semantics.

**Recommended fix:** No code change. Document this pattern in module comments.

### INFORMATIONAL-2: Event correlation dependency requires off-chain indexer awareness

**Location:** `lock.move:61-65` (`FeesClaimed` event)

**Description:** Deliberate omission of `pool_addr` forces indexers to correlate via `position_addr` + tx hash.

**Impact:** Indexing complexity — off-chain consumers must implement a two-step event correlation pipeline.

**Recommended fix:** Publish a canonical indexer reference implementation or JSON schema alongside deployment docs specifying the exact join keys (`position_addr` + `tx_version`). Consider adding `pool_addr` in a future satellite update if core ever exposes a public getter, but current stance is acceptable.

### INFORMATIONAL-3: `lock_position_and_get` public exposure increases API surface

**Location:** `lock.move:75`

**Description:** Exposing `lock_position_and_get` as `public fun` allows any Move module to call it. While secure (requires owned `LpPosition` + `&signer`), it creates an additional entry point that could be wrapped by third-party modules.

**Impact:** Negligible. No authorization bypass or state corruption possible.

**Recommended fix:** Keep as `public` to preserve composability (matches `pool::add_liquidity` pattern).

---

## Design questions answered

| ID | Auditor Response |
|----|------------------|
| **D-1** | **Yes.** Correlation via `position_addr` + same-tx event indexing is the most secure and pragmatic path. Avoids spoofable caller-supplied params, respects zero-core-touch. |
| **D-2** | **Strict `>` is correct.** Allowing `== now` introduces UX ambiguity. `u64::MAX` as permanent lock is clean and avoids branching. |
| **D-3** | **None.** The function requires `&signer` and owned `Object<LpPosition>`. No capability can be forged. Public exposure enables legitimate composability without security trade-offs. |
| **D-4** | **Yes.** Permit/delegation layer would duplicate `object::transfer` semantics, increase attack surface, and contradict "se-primitive" philosophy. |
| **D-5** | **Unnecessary paternalism.** `u64` covers ~584M years. No technical or economic justification for capping. |
| **D-6** | **Correct.** Immutability of `unlock_at` eliminates state-mutation vectors. "Redeem + re-lock" is the canonical, auditable path. |
| **D-7** | **Yes.** Aptos `compatible` policy statically forbids ABI-breaking changes. A version guard adds gas without meaningful security benefit. |

---

## What Qwen called out as "got right"

| Decision | Assessment |
|----------|-----------|
| External satellite over core upgrade | ✅ Excellent risk isolation |
| Single struct with embedded refs | ✅ Clean encapsulation, no dangling pointer risks |
| `object::owner` as sole auth source | ✅ Matches Aptos-native patterns |
| Explicit `E_INVALID_UNLOCK` | ✅ Clear failure semantics |
| Three distinct events | ✅ Simplifies ABI mapping |
| No deadline on entries | ✅ Correctly identified as non-mempool-sensitive |
| Correlation-based event attribution | ✅ Pragmatic workaround, robust and indexer-friendly |
| `lock_position_and_get` sibling pattern | ✅ Enables testing & composability without bloating entries |
| No extend/shorten | ✅ Reduces state-mutation complexity |
| Transferability preserves lock state | ✅ Leverages Aptos object model correctly |

---

## Overall verdict

> 🟢 **GREEN for mainnet publish readiness.**
>
> The `darbitex_lp_locker` module exhibits production-grade Move engineering. Authorization is strictly bound to `object::owner` checks, state transitions are atomic, linear types prevent asset loss, and the design intentionally minimizes surface area. All stated threat model vectors are mitigated by core Move semantics or explicit framework guards. The single LOW finding relates to gas optimization, not security. No changes are required for safe mainnet deployment.
>
> The codebase is a textbook example of minimalist, security-first Move satellite development. Proceed to mainnet with confidence.
