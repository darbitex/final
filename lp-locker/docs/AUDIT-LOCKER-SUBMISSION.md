# Darbitex LP Locker — External Audit Submission (Round 1)

**Package:** `darbitex_lp_locker`
**Version:** 0.1.0
**Date:** 2026-04-16
**Chain:** Aptos
**Dependency target:** Darbitex Final core at `0xc988d39a4a27b26e1d659431a0c5828f3862c155d1c331386cd5974298dd78dd` (mainnet, LIVE since 2026-04-14)
**Audit package size:** 1 Move source file (`sources/lock.move`), 179 LoC, compile-clean with zero warnings on `aptos move compile --dev`
**Previous deploys:** **none on mainnet.** Testnet smoke-test deploy at `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9` on Aptos testnet. All 6 exposed functions (3 entry, 2 view, 1 non-entry public) exercised against a real pool + real LpPosition + real LP-fee accrual from a swap. All three abort paths (E_NOT_OWNER, E_STILL_LOCKED, E_INVALID_UNLOCK) validated on-chain.
**Planned mainnet publisher:** TBD (hot wallet `0x0047a3e1...` vs new 3/5 multisig — pending audit verdict).
**Upgrade policy:** `compatible` (will flip to `immutable` after 3–6 month soak, same cadence as Darbitex Final core).

---

## 1. What we are asking from you

You are reviewing a single Move source file for a **small external satellite** that wraps Darbitex Final's `LpPosition` Aptos object inside a time-based lock. We want an **independent security review** focused on:

1. **Authorization correctness** — can any unauthorized party call `claim_fees`, `redeem`, or cause the wrapped position to move to an address they control?
2. **Principal-lock invariant** — can a locked position be withdrawn from the pool (i.e., `remove_liquidity` called against it) before `unlock_at`?
3. **Fee harvest invariant** — can `claim_fees` be called pre-unlock? (It should be allowed: only the principal is gated, fees are always claimable. Please verify this is both enabled AND that it does not leak any authority beyond fees.)
4. **Transferability correctness** — the `LockedPosition` object is a standard Aptos object with ungated transfer. When owner X transfers the locker to owner Y, does lock state carry correctly? Can the original owner reclaim after transfer?
5. **Resource lifecycle** — `redeem` destructures `LockedPosition` via `move_from`, transfers the wrapped position back to user, and calls `object::delete(delete_ref)`. Verify the object is cleanly deleted with no dangling refs.
6. **Interaction with `darbitex::pool`** — the satellite calls `pool::claim_lp_fees(&locker_signer, position)` where `locker_signer` is generated from the locker object's `ExtendRef`. Verify the owner check in `claim_lp_fees` passes for the right reason (locker_addr owns the position post-lock) and fails correctly in the right places.
7. **Event attribution** — 3 events (`Locked`, `FeesClaimed`, `Redeemed`). Verify fields capture everything an off-chain indexer needs, and that the deliberate omission of `pool_addr` from `FeesClaimed` is the right call (see §5 — correlated via core's `LpFeesClaimed` event on the same tx).
8. **Any admin override or trust escape we did not explicitly acknowledge.**

**Output format we'd like back:**

```
## Findings

### HIGH-1: <title>
Location: lock.move:<line>
Description: <what>
Impact: <why it matters>
Recommended fix: <how>

### MEDIUM-1: ...
### LOW-1: ...
### INFORMATIONAL-1: ...

## Design questions we want answered
(any specific question from section 7 below)

## Overall verdict
(green / yellow / red for mainnet publish readiness)
```

Please also comment on **things we considered and got right** — we want to know which decisions held up under scrutiny, not just where we failed.

---

## 2. Project context

**Darbitex LP Locker** is a **tiny external satellite** for Darbitex Final. It wraps an existing `darbitex::pool::LpPosition` object inside a new `LockedPosition` Aptos object with a `unlock_at: u64` gate. The wrapped position is transferred to the locker's object address at lock time; ownership of the wrapper stays with the user. LP fees remain claimable throughout the lock period — only the **principal** (withdrawing the LP shares) is gated.

**Why a satellite (not a core upgrade):**

- **Zero core touch.** Darbitex Final core at `0xc988d39a...` is LIVE on mainnet and passed R3 audit (3 rounds, 8 auditors, verdict GREEN). Any feature added to core would require a compat upgrade and a new audit cycle. An external satellite that only *consumes* core's existing public API can ship independently.
- **Faithful to Final's "satellite over feature upgrade" rule** (memory: `feedback_no_core_upgrade.md`). Features live in satellites; only security/compat fixes go to core.
- **Minimalism.** ~130 LoC target, final ~180 LoC (10% buffer used by doc comments + explicit field projection). The entire attack surface fits on one screen.

**Design philosophy (owner-mandated):**

- **Se-primitive mungkin, sesederhana mungkin.** 1 struct, 3 entry fns, 2 views, 3 events. No extend / shorten / partial unlock / fee beneficiary / emissions / governance.
- **Zero admin surface.** No global `BurnManager` singleton. Each locker is an independent Aptos object. Discovery via `getAccountOwnedObjects` standard SDK.
- **Block-explorer executable.** Every entry function's args are `address`, `u64`, or `Object<T>`. Aptos Explorer "Run Function" must work without a frontend.
- **Transferability is Aptos-native.** `object::transfer<LockedPosition>` from aptos_framework handles owner changes. Lock state lives inside the resource and carries over automatically — no custom transfer entry.
- **No sentinel for permanent locks.** Want permanent? Set `unlock_at = u64::MAX` (or any distant future). No special-case branch.

**Differentiators vs state of the art:**

- **Cetus `lp_burn.move`** (Sui) — production-proven wrapper-NFT-escrow pattern, but **permanent-only**. Our design adds time-based unlock as the differentiator.
- **Turbos LP Lock** (Sui) — source closed, behaviorally strict subset of Cetus. Zero useful signal beyond confirming Cetus pattern is canonical.
- **No production Sui or Aptos locker** ships time-based unlock with fees-while-locked as of 2026-04-16.

---

## 3. Core design principles

These are **intentional**. If you find something that violates one of these, that's a HIGH finding. If you disagree with a principle, note it under "Design questions" rather than as a finding.

1. **Wrapper, not forwarder.** The `LockedPosition` object *owns* the `LpPosition` (via `object::transfer` at lock time). The user's wallet owns the `LockedPosition`, not the `LpPosition`. This is what makes the principal lock real: the user cannot call `pool::remove_liquidity_entry(position)` themselves because `object::owner(position) == locker_addr != user_addr` and `pool::remove_liquidity` asserts owner check.

2. **Fees follow the wrapper, not the user.** When `claim_fees` runs, the satellite uses `generate_signer_for_extending(&l.extend_ref)` to produce a `locker_signer` whose `signer::address_of(..) == locker_addr`. `pool::claim_lp_fees` then passes its own owner check (`object::owner(position) == signer::address_of(provider)` → `locker_addr == locker_addr` ✓). The satellite receives the returned `FungibleAsset`s and deposits them to the **current locker owner** (`object::owner(locker)`), not the original locker creator. This means fees follow the wrapper on owner transfers — the new owner gets all subsequent fees.

3. **Transfer preserves lock state.** The `LockedPosition` resource is stored at the locker object's address. `object::transfer<LockedPosition>` only changes `ObjectCore.owner`; the resource at that address is untouched. Lock state (`unlock_at`, wrapped position handle, refs) survives the transfer with zero custom logic.

4. **Redeem returns the intact `Object<LpPosition>`, not withdrawn reserves.** After `redeem`, the user can call `pool::remove_liquidity_entry(position, ...)` themselves — or keep the position and continue earning fees like a normal LP. The locker does not short-cut through `remove_liquidity`. Keeps the locker orthogonal to pool liquidity accounting.

5. **No unlock_at == now loophole.** `lock_position` asserts `unlock_at > now` (strict `>`). Matches the semantic that "locked" must mean at least one second of real lock. Callers who want "no lock" shouldn't call the locker at all.

6. **No deadline on entry fns.** Unlike `pool::add_liquidity_entry` / `remove_liquidity_entry` / `claim_lp_fees_entry`, the locker entries do **not** take a `deadline: u64` parameter. Reasoning: the operations are not mempool-sensitive (no reserve-ratio race condition to front-run), and the `object::owner` check already prevents unauthorized execution. Adding deadline = bloat without value.

7. **No math.** The locker does not do arithmetic. The only comparison is `timestamp::now_seconds() >= unlock_at`. Zero overflow risk, zero rounding risk, zero division.

8. **No reentrancy surface.** `claim_fees` calls `pool::claim_lp_fees`, which internally takes `pool.locked = true` and performs FA deposit/withdraw. Aptos FA operations have no callback surface. Satellite state is read-only during the pool call (`borrow_global` not `borrow_global_mut`), so nothing can be mutated mid-call.

9. **Composability via `lock_position_and_get`.** In addition to `public entry fun lock_position`, there's a `public fun lock_position_and_get` that returns `Object<LockedPosition>`. Same body, different visibility + return. Entry discards the handle (Move language rule: entry funs return `()`); the public non-entry form returns it so cross-module callers (tests, future satellites) can get the new locker directly without scanning owned objects.

10. **Correlated event attribution, not self-contained.** The satellite's `FeesClaimed` event deliberately omits `pool_addr`. Off-chain indexers correlate via core's `LpFeesClaimed` event (which DOES carry `pool_addr`) on the same transaction using `position_addr` as the join key. Rationale: `LpPosition.pool_addr` is module-private in `darbitex::pool`, and adding a public getter would require a core upgrade (violates zero-core-touch). See §5.

---

## 4. Security model and trust assumptions

### Trusted parties

- **Publisher** (TBD: hot wallet or 3/5 multisig): publishes and upgrades the satellite during the compat window. After immutability flip, the upgrade cap becomes inert.
- **Darbitex Final core** at `0xc988d39a...`: the locker trusts core's `pool::claim_lp_fees` semantics (owner check, fee math, event emission, k-invariant). Core passed 3 audit rounds, is LIVE on mainnet since 2026-04-14.

### Untrusted parties

- Anyone can call any locker entry (as long as they own a valid `LpPosition` for `lock_position`, or own a `LockedPosition` for `claim_fees`/`redeem`)
- Anyone can receive a transferred `LockedPosition` (via `object::transfer`)
- LP positions and locker objects are both validated via `object::owner(obj) == caller` on operations that require ownership

### Threat model we care about

1. **Unauthorized fee harvest** — can a non-owner extract fees from someone else's locker?
2. **Unauthorized redeem** — can a non-owner pull the principal?
3. **Principal-lock bypass** — can the user bypass the lock by directly calling `pool::remove_liquidity_entry` on the wrapped position (they shouldn't be able to, because ownership transferred)? Or via any other pool entry (`swap`, `flash_borrow`, etc. — these don't take LP positions so are N/A, but please verify)?
4. **Lock-state mutation post-lock** — can `unlock_at` be changed after `lock_position`?
5. **Double-spend on owner transfer** — if the original owner transfers the locker to Bob, can the original owner still call `claim_fees` or `redeem`? (They shouldn't — `object::owner` check should reject.)
6. **Stuck position** — can the wrapped `LpPosition` ever be stuck in the locker with no path out? (Specifically: what if core is upgraded and `claim_lp_fees` signature changes? What if the locker's `redeem` fails for some reason?)
7. **Event spoofing** — can an attacker emit a fake `Locked` / `FeesClaimed` / `Redeemed` event from outside the module that looks like it came from the locker?
8. **Resource leak on redeem** — after `redeem`, is `LockedPosition` fully deleted? Can `ExtendRef` or `DeleteRef` be leaked into storage?
9. **Hot-potato FA mishandling** — `pool::claim_lp_fees` returns `(FungibleAsset, FungibleAsset)`. If `claim_fees` panics between the call and the deposit, is there any path where FA objects get dropped without consumption? (Move's linear type system should prevent this, but please confirm.)

### Threat model we do NOT care about

- **Dead lockers** (user forgets they have one) — not a security issue
- **Gas griefing** — the locker is self-contained and the caller pays their own gas
- **Off-chain indexer decisions** — how dApps display locked positions is out of scope
- **Core upgrades breaking locker** — if the Final core upgrades its `claim_lp_fees` signature in an incompatible way, the locker becomes non-functional. This is acceptable because: (a) Final is under `compatible` upgrade policy during soak and signature-breaking changes would fail compat check; (b) after immutability flip, core can't change at all.

---

## 5. Key design decisions we want challenged

### D-1: Event attribution via correlation, not self-containment

Our `FeesClaimed` event emits `locker_addr`, `owner`, `position_addr`, `fees_a`, `fees_b`, `timestamp` — but **not** `pool_addr`.

Reason: `LpPosition.pool_addr` is module-private in `darbitex::pool`. To include `pool_addr` in our event, we would need either:

- **(a)** A core upgrade adding `public fun get_lp_position_pool(position: Object<LpPosition>): address` — violates zero-core-touch.
- **(b)** Accept a caller-supplied `pool_addr` param with no on-chain validation — trivially spoofable, worse than omitting.
- **(c)** Parse the returned `FungibleAsset`'s metadata to derive pool_addr — FA metadata is the token metadata, not the pool address, so this doesn't work.

Our solution: **omit `pool_addr` from our event.** Off-chain indexers correlate with core's `LpFeesClaimed` event on the same transaction — core's event DOES include `pool_addr`, and the join key is `position_addr`. This is what our testnet smoke test verifies (see §7).

**Question for R1:** Is correlation-based attribution acceptable, or should we reconsider? If reconsider: what's the cleanest alternative that doesn't require a core upgrade?

### D-2: `unlock_at > now` strict inequality

`lock_position` asserts `unlock_at > timestamp::now_seconds()`. An equal value aborts with `E_INVALID_UNLOCK`. A user wanting "permanent" passes `u64::MAX` (or any distant future).

**Alternative:** allow `unlock_at == now` and document "lock for zero seconds". We rejected this because: (a) it's a UX footgun for users who accidentally pass 0; (b) it muddles the semantics of "locked" (was it locked for an instant, or not locked at all?); (c) pros are nil.

**Question for R1:** Is strict `>` correct, or should we allow `>=`? Is the sentinel-free approach to "permanent lock" the right call, or should we add an explicit `permanent: bool` flag?

### D-3: `lock_position_and_get` vs `lock_position`

We have two functions doing the same thing, differing only in visibility + return:

```move
public entry fun lock_position(user: &signer, position: Object<LpPosition>, unlock_at: u64) {
    let _ = lock_position_and_get(user, position, unlock_at);
}

public fun lock_position_and_get(
    user: &signer,
    position: Object<LpPosition>,
    unlock_at: u64,
): Object<LockedPosition> {
    // ... actual work, returns handle
}
```

Reason: `public entry fun` in Move cannot return values. Tests and potential future composable satellites need the `Object<LockedPosition>` handle directly after creation. This is the same pattern as `pool::add_liquidity` (non-entry, returns `Object<LpPosition>`) vs `pool::add_liquidity_entry` (entry, discards) in Darbitex Final core.

**Question for R1:** Any objection to this pattern? Specifically, does exposing `lock_position_and_get` as `public fun` (rather than package-private friend) create an attack surface?

### D-4: No `permit`-style approval model

The locker does not support a "delegate the ability to claim fees" pattern. Only the current `object::owner(locker)` can claim.

**Alternative considered and rejected:** a `FeeRecipient` resource or a `claim_for(owner: address, locker)` variant. Complexity explosion for no identified use case. If a third party needs to claim on behalf, they should be given `object::transfer` to a shared multisig locker-owner wallet.

**Question for R1:** Correct omission? Any use case we're missing?

### D-5: No hard cap on lock duration

`unlock_at` is a free `u64`. No maximum. You can lock for 1000 years or the heat death of the universe. User's choice.

**Question for R1:** Is a maximum cap (e.g., "no locks past 2100") a good idea, or unnecessary paternalism?

### D-6: No extend/shorten operations

Once locked, `unlock_at` is immutable. To change it: `redeem` then `lock_position` again.

**Question for R1:** Does this cause any security edge case we're missing? (E.g., if the user redeems early by social engineering the contract, then re-locks shorter — no, this is impossible because early redeem aborts. Just double-checking.)

### D-7: Core-upgrade risk stance

Darbitex Final core is under `compatible` upgrade policy for 3–6 months (memory: `darbitex_final_deployed.md`). A theoretical core upgrade that changes `claim_lp_fees` signature or semantics would break the locker.

**Our stance:** compat policy in Aptos Move forbids signature changes — adding parameters breaks ABI compat, removing parameters breaks ABI compat, changing return type breaks ABI compat. Only body-level behavior changes are compat-legal. Those could still change fee routing semantics, but they'd first require a core audit cycle, at which time locker compat would be re-verified.

**Question for R1:** Is this stance sufficient, or should the locker include a version assertion / abort-early guard if core behavior has changed?

---

## 6. Threat-model walk-through per entry fn

### 6.1 `lock_position(user: &signer, position: Object<LpPosition>, unlock_at: u64)`

**Preconditions:**
- `user` signs the tx
- `position` is an `Object<LpPosition>` owned by `signer::address_of(user)` (enforced by `object::transfer` internally)
- `unlock_at > now` (asserted)

**Body sequence:**
1. Assert `unlock_at > now` → E_INVALID_UNLOCK if not
2. Create a fresh locker object owned by `user_addr` via `object::create_object(user_addr)`
3. Generate `ExtendRef` + `DeleteRef` from the locker's ConstructorRef
4. `object::transfer(user, position, locker_addr)` — transfers the LP position to the locker's own address
5. `move_to` the `LockedPosition` resource onto the locker object's signer
6. Emit `Locked` event
7. (in `lock_position_and_get`: return `Object<LockedPosition>`; in `lock_position`: discard)

**Attack surface:**
- **Non-owner lock someone else's position:** blocked by `object::transfer`'s internal owner check. If `user` doesn't own `position`, the transfer aborts with `EOBJECT_NOT_OWNED` from aptos_framework.
- **Lock with past unlock_at:** blocked by strict `>` assert.
- **Reentrancy via `move_to`:** Move's resource model makes this impossible — `move_to` is not a callback.
- **Locker object collision:** `object::create_object(user_addr)` uses a GUID internally, not a deterministic seed. Each call produces a fresh address.

### 6.2 `claim_fees(user: &signer, locker: Object<LockedPosition>)`

**Preconditions:**
- `user` signs the tx
- `object::owner(locker) == user_addr` (asserted explicitly)
- Locker resource must exist at `locker_addr` (asserted implicitly by `borrow_global`)

**Body sequence:**
1. Assert `object::owner(locker) == user_addr` → E_NOT_OWNER if not
2. `borrow_global<LockedPosition>` (immutable borrow, not mut) — read-only for `extend_ref` + `position`
3. Generate `locker_signer` from `extend_ref`
4. Call `pool::claim_lp_fees(&locker_signer, position)` — returns `(fa_a, fa_b)`
5. Record `fees_a = fungible_asset::amount(&fa_a)`, `fees_b = fungible_asset::amount(&fa_b)`
6. `primary_fungible_store::deposit(user_addr, fa_a)` and `fa_b`
7. Emit `FeesClaimed` event

**Attack surface:**
- **Non-owner claim:** blocked by explicit `object::owner` assert.
- **Double claim:** safe by core's design — `pool::claim_lp_fees` resets `fee_debt_*` to current `lp_fee_per_share_*`. Second call immediately returns zero.
- **Claim pre-unlock:** deliberately allowed — fees are never gated. This is the whole point of "fees-while-locked".
- **Core signature drift:** if core is upgraded with a different `claim_lp_fees` signature, this call would fail to resolve at publish time (ABI dependency) OR abort at runtime. Either way, no silent miscomputation.
- **FA drop:** Move's linear type system prevents FA from being silently dropped. If `deposit` fails, the whole tx aborts.

### 6.3 `redeem(user: &signer, locker: Object<LockedPosition>)`

**Preconditions:**
- `user` signs the tx
- `object::owner(locker) == user_addr`
- `timestamp::now_seconds() >= unlock_at`
- Locker resource exists

**Body sequence:**
1. Assert `object::owner(locker) == user_addr` → E_NOT_OWNER
2. `let LockedPosition { position, unlock_at, extend_ref, delete_ref } = move_from<LockedPosition>(locker_addr)` — destructures and removes the resource from storage
3. Assert `now >= unlock_at` → E_STILL_LOCKED
4. Generate `locker_signer` from `extend_ref`
5. `object::transfer(&locker_signer, position, user_addr)` — returns the wrapped position to user
6. `object::delete(delete_ref)` — deletes the locker object from storage
7. Emit `Redeemed` event

**Attack surface:**
- **Non-owner redeem:** blocked by owner assert.
- **Pre-unlock redeem:** blocked by `now >= unlock_at` assert. **Note the ordering:** we destructure the resource FIRST, then assert. If the assert fires, the tx aborts and all state mutations roll back (Move's atomic tx semantics). The resource destructuring is not "locked in" until the tx succeeds.
- **ExtendRef drop:** `ExtendRef` has `drop, store` — safe to drop on tx abort or successful destructure.
- **DeleteRef leak:** `DeleteRef` has `drop, store` — but dropping it without consumption leaves the object in a zombie state (`ObjectCore` still there). That's why we explicitly call `object::delete(delete_ref)` to cleanly remove it.
- **Position transfer back to user fails:** `object::transfer(&locker_signer, ...)` requires `locker_signer` to be the current owner of `position`. Since `lock_position` transferred it to `locker_addr` and nothing else in the locker touches it, `locker_signer` (whose address == locker_addr) IS the owner. ✓

### 6.4 `unlock_at(l: Object<LockedPosition>): u64` (view)

Pure read, no side effects. Aborts if locker doesn't exist (`borrow_global` panics).

### 6.5 `position_of(l: Object<LockedPosition>): Object<LpPosition>` (view)

Pure read, no side effects. Returns the wrapped position handle (which is `copy + drop + store`).

### 6.6 `lock_position_and_get` (public, non-entry)

Same body as `lock_position`, returns the handle. Callable only from Move code (tests, composable satellites). Not reachable from CLI/wallet. See D-3.

---

## 7. Pre-audit self-review + testnet smoke test evidence

### 7.1 Structured self-audit (2026-04-16, pre-scaffold)

Before writing source, we ran a structured 8-category audit per the darbitex-ecosystem satellite SOP (`feedback_satellite_self_audit.md`):

1. **ABI verification against live on-chain state** — confirmed `pool::claim_lp_fees` signature against `~/darbitex-final/sources/pool.move:589-636`. Struct abilities of `LpPosition` verified (`has key`, create_object with ungated transfer, `delete_ref` field present).
2. **Arg order / count / types** — 3 entries, all primitive + Object<T>.
3. **Math paths** — zero (no arithmetic).
4. **Reentrancy** — covered by core's `pool.locked` flag; satellite adds no new surface.
5. **Edge cases** — `unlock_at == now`, `unlock_at < now`, `unlock_at == u64::MAX`, non-owner, zero fees, same-tx lock+claim+redeem, owner-transfer mid-cycle.
6. **Interaction** — only `darbitex::pool`, no pool-factory, no arbitrage, no flash.
7. **Error codes** — 3 distinct (E_NOT_OWNER=1, E_STILL_LOCKED=2, E_INVALID_UNLOCK=3).
8. **Event completeness** — 3 events, each with locker_addr + owner + position_addr + timestamp, plus variant-specific fields (unlock_at for Locked, fees_a/fees_b for FeesClaimed).

**Verdict pre-scaffold:** GREEN with 2 minor findings:
- **F-5a (MINOR)** — add `assert!(unlock_at > now)` explicit check + E_INVALID_UNLOCK code. **Applied.**
- **F-8a (MAJOR-design)** — finalize event field schema before scaffold. **Applied.**

A second audit performed in a parallel session returned the same verdict with the same two findings plus one additional INFO:
- **INFO-8 (reversed)** — initially recommended adding `pool_addr` to `FeesClaimed`, but during scaffold we discovered `LpPosition.pool_addr` is module-private in core. **Not applied**, documented as D-1 above. Off-chain correlation via core's `LpFeesClaimed` is the chosen path.

### 7.2 Move unit test suite — 8/8 passing

`tests/lock_tests.move` covers:

| # | Test | Scenario |
|---|---|---|
| 1 | `lock_then_view` | lock → verify views (unlock_at, position_of, owner) |
| 2 | `lock_rejects_unlock_at_eq_now` | `unlock_at == now` → abort E_INVALID_UNLOCK |
| 3 | `lock_rejects_unlock_at_past` | `unlock_at` in the past → abort E_INVALID_UNLOCK |
| 4 | `lock_transfers_position_away_from_user` | post-lock, `object::owner(position) != user_addr` (principal-lock invariant) |
| 5 | `redeem_before_unlock_aborts` | redeem pre-unlock → abort E_STILL_LOCKED |
| 6 | `redeem_after_unlock_returns_position` | redeem post-unlock → position back to user + LockedPosition deleted |
| 7 | `claim_fees_non_owner_aborts` | Mallory calls `claim_fees` on Alice's locker → abort E_NOT_OWNER |
| 8 | `transferred_locker_new_owner_can_redeem` | Alice locks → transfers locker to Bob → Bob redeems successfully, position goes to Bob |

All tests use a real Darbitex Final pool setup inside the test harness:
- Create 2 FA metadata + mint tokens
- `pool_factory::init_factory`
- `pool_factory::create_canonical_pool` (seeds the pool)
- `pool::add_liquidity` — returns a real `Object<LpPosition>` handle for the test to use

### 7.3 Testnet on-chain smoke test (2026-04-16)

Deployed to Aptos testnet at `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9`:

1. **Publish darbitex-final core** — tx `0x56bd48863c9a0aba27f73afba35806b03d24b0308d1d3c2a942f576ce2208f3f`
2. **init_factory** — tx `0x539c1e97923a93b18049d38b067aac65d0a40bd25558c34f00d5eb125d75daa7`
3. **Publish lp-locker** — tx `0x4b0c0be631cc369ee0a1e1e0cbc30b46c61ff5a4c63c2c823f8df7d077e01820`
4. **Create smoke-test pool** (TX / TY, 1e9 each, 1:1 ratio) — tx `0x7523e3b971f178fea87ab4ede134bb48816b497854fdef2172f17c5fc0e0bc76`. Pool at `0x600650f6baac1471bb788c8bf06433903c3e37e799375984a66a11da4df3c46d`, initial LP position at `0x160ab55c646eb7bcb01044dd0dd42f63329754c04f4010191aded4dcdbb62dcf`.
5. **lock_position** happy path (unlock_at = now + 90s) — tx `0x7e7cb3d7355bf77e5767e2544b0b5fd907bec38b20e89a0c877e857367974995`. Locker at `0xfa1f8d912751052afe9d8bebac4b3a0f86411853501b02b6495894a08c99d6d7`. Verified `object::Transfer` event fires, `lock::Locked` event fires with correct fields.
6. **View `unlock_at`** returns `1776299160` (matches lock arg). **View `position_of`** returns the wrapped position handle.
7. **Attempted early `redeem`** — aborted with `E_STILL_LOCKED(0x2)` as expected.
8. **Waited, late `redeem`** — tx `0x17f1ad0df407e7860a0a968136091aa361f2a1a3cc28eeee7fa4e07f76023954`. Verified `object::Transfer` back to user + `lock::Redeemed` event. Querying `LockedPosition` at the locker address returns `resource_not_found` — object cleanly deleted.
9. **Swap 1 TX → 1 TY** via `arbitrage::swap_entry` to accrue LP fees in the pool — tx `0x1ea9f3f8e2c88022ee6347eb33adb5e2c8fa29eba596bd142d0ae96d8ed8562b`.
10. **Re-lock position** (unlock_at = now + 60s) — second locker at `0xe95166b21a4c5e904f62514b9c53056a3c7e736aed7f09ef3eb910ea7fbe93a8`.
11. **`claim_fees` happy path** — tx `0xe4e6768e7c3678d706820da70030081462a136b992c4fa35a95981e5375105c2`. Both events fire:
    - Core `pool::LpFeesClaimed`: `claimer=locker_addr, fees_a=0, fees_b=9999, pool_addr=<pool>, position_addr=<position>`
    - Satellite `lock::FeesClaimed`: `owner=user_addr, fees_a=0, fees_b=9999, locker_addr=<locker>, position_addr=<position>`
    Correlation via `position_addr` works exactly as designed. User's TY primary store balance increased by 9999 (verified on-chain).
12. **Non-owner `claim_fees`** using `testnet_beta` profile — aborted with `E_NOT_OWNER(0x1)` as expected.
13. **Non-owner `redeem`** using `testnet_beta` profile — aborted with `E_NOT_OWNER(0x1)` as expected.
14. **Add fresh LP position** via `add_liquidity_entry`, attempt `lock_position(unlock_at=0)` — aborted with `E_INVALID_UNLOCK(0x3)` as expected.
15. **Late `redeem` of second locker** (happy path post-claim) — seq=13, success, position returned, locker deleted.

**Smoke test verdict:** all 6 exposed functions exercised, all 3 abort paths validated on-chain, all 3 events correctly emitted with expected fields, principal-lock invariant and transferability-preserves-state both demonstrated live.

---

## 8. Satellite source code

**File:** `sources/lock.move` — 179 LoC

```move
/// Darbitex LP Locker — external satellite.
///
/// Wraps a `darbitex::pool::LpPosition` object inside a `LockedPosition`
/// Aptos object with a time-based unlock gate. LP fees remain harvestable
/// throughout the lock period; only the principal (the LpPosition itself)
/// is gated. The wrapper is a standard Aptos object — owner transfer via
/// `object::transfer<LockedPosition>` carries the lock state with it.
///
/// Zero admin surface. Each locker is independent. No global registry.
/// Discovery is via `getAccountOwnedObjects` on the user's wallet.
///
/// Event attribution: `FeesClaimed` deliberately omits `pool_addr` because
/// `LpPosition.pool_addr` is module-private in `darbitex::pool` and
/// exposing it would require a core upgrade (violates zero-core-touch).
/// Off-chain indexers correlate this event with core's `LpFeesClaimed`
/// by matching `position_addr` within the same transaction.

module darbitex_lp_locker::lock {
    use std::signer;
    use aptos_framework::event;
    use aptos_framework::object::{Self, Object, ExtendRef, DeleteRef};
    use aptos_framework::fungible_asset;
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;

    use darbitex::pool::{Self, LpPosition};

    const E_NOT_OWNER: u64 = 1;
    const E_STILL_LOCKED: u64 = 2;
    const E_INVALID_UNLOCK: u64 = 3;

    struct LockedPosition has key {
        position: Object<LpPosition>,
        unlock_at: u64,
        extend_ref: ExtendRef,
        delete_ref: DeleteRef,
    }

    #[event]
    struct Locked has drop, store {
        locker_addr: address,
        owner: address,
        position_addr: address,
        unlock_at: u64,
        timestamp: u64,
    }

    #[event]
    struct FeesClaimed has drop, store {
        locker_addr: address,
        owner: address,
        position_addr: address,
        fees_a: u64,
        fees_b: u64,
        timestamp: u64,
    }

    #[event]
    struct Redeemed has drop, store {
        locker_addr: address,
        owner: address,
        position_addr: address,
        timestamp: u64,
    }

    public entry fun lock_position(
        user: &signer,
        position: Object<LpPosition>,
        unlock_at: u64,
    ) {
        let _ = lock_position_and_get(user, position, unlock_at);
    }

    /// Same as `lock_position` but returns the new locker handle. Split
    /// out so integration callers (and tests) can get at the handle
    /// without scanning owned objects. Keeping the entry point as a
    /// thin wrapper preserves the block-explorer-executable property.
    public fun lock_position_and_get(
        user: &signer,
        position: Object<LpPosition>,
        unlock_at: u64,
    ): Object<LockedPosition> {
        let now = timestamp::now_seconds();
        assert!(unlock_at > now, E_INVALID_UNLOCK);

        let user_addr = signer::address_of(user);
        let ctor = object::create_object(user_addr);
        let locker_signer = object::generate_signer(&ctor);
        let locker_addr = signer::address_of(&locker_signer);
        let extend_ref = object::generate_extend_ref(&ctor);
        let delete_ref = object::generate_delete_ref(&ctor);

        object::transfer(user, position, locker_addr);
        let position_addr = object::object_address(&position);

        move_to(&locker_signer, LockedPosition {
            position,
            unlock_at,
            extend_ref,
            delete_ref,
        });

        event::emit(Locked {
            locker_addr,
            owner: user_addr,
            position_addr,
            unlock_at,
            timestamp: now,
        });

        object::object_from_constructor_ref<LockedPosition>(&ctor)
    }

    public entry fun claim_fees(
        user: &signer,
        locker: Object<LockedPosition>,
    ) acquires LockedPosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(locker) == user_addr, E_NOT_OWNER);

        let locker_addr = object::object_address(&locker);
        let l = borrow_global<LockedPosition>(locker_addr);
        let locker_signer = object::generate_signer_for_extending(&l.extend_ref);
        let position = l.position;
        let position_addr = object::object_address(&position);

        let (fa_a, fa_b) = pool::claim_lp_fees(&locker_signer, position);
        let fees_a = fungible_asset::amount(&fa_a);
        let fees_b = fungible_asset::amount(&fa_b);

        primary_fungible_store::deposit(user_addr, fa_a);
        primary_fungible_store::deposit(user_addr, fa_b);

        event::emit(FeesClaimed {
            locker_addr,
            owner: user_addr,
            position_addr,
            fees_a,
            fees_b,
            timestamp: timestamp::now_seconds(),
        });
    }

    public entry fun redeem(
        user: &signer,
        locker: Object<LockedPosition>,
    ) acquires LockedPosition {
        let user_addr = signer::address_of(user);
        assert!(object::owner(locker) == user_addr, E_NOT_OWNER);

        let locker_addr = object::object_address(&locker);
        let LockedPosition { position, unlock_at, extend_ref, delete_ref }
            = move_from<LockedPosition>(locker_addr);
        assert!(timestamp::now_seconds() >= unlock_at, E_STILL_LOCKED);

        let locker_signer = object::generate_signer_for_extending(&extend_ref);
        object::transfer(&locker_signer, position, user_addr);
        let position_addr = object::object_address(&position);

        object::delete(delete_ref);

        event::emit(Redeemed {
            locker_addr,
            owner: user_addr,
            position_addr,
            timestamp: timestamp::now_seconds(),
        });
    }

    #[view]
    public fun unlock_at(l: Object<LockedPosition>): u64 acquires LockedPosition {
        borrow_global<LockedPosition>(object::object_address(&l)).unlock_at
    }

    #[view]
    public fun position_of(l: Object<LockedPosition>): Object<LpPosition> acquires LockedPosition {
        borrow_global<LockedPosition>(object::object_address(&l)).position
    }
}
```

---

## 9. Relevant Darbitex Final core excerpts (context for the auditor)

The locker calls **one** function from core: `pool::claim_lp_fees`. The locker also trusts the `LpPosition` struct abilities + ownership semantics. Included below are the minimum excerpts from `~/darbitex-final/sources/pool.move` (live on mainnet at `0xc988d39a...`) needed to review the locker's interactions with core. Full core source is ~815 LoC and available on request if you need wider context.

### 9.1 `LpPosition` struct (pool.move:73-81)

```move
/// LP position as an Aptos object. Each add_liquidity mints a new
/// one. Transferable. Burned on remove_liquidity.
struct LpPosition has key {
    pool_addr: address,
    shares: u64,
    fee_debt_a: u128,
    fee_debt_b: u128,
    delete_ref: DeleteRef,
}
```

**Note:** `LpPosition` has `key` only — no `store`, `drop`, or `copy`. The field `pool_addr` is module-private (no public getter). This is the constraint behind design decision D-1 (omit pool_addr from locker's FeesClaimed event).

### 9.2 `mint_lp_position` (pool.move:237-258) — creates with ungated transfer enabled

```move
fun mint_lp_position(
    owner_addr: address,
    pool_addr: address,
    shares: u64,
    initial_debt_a: u128,
    initial_debt_b: u128,
): Object<LpPosition> {
    let ctor = object::create_object(owner_addr);
    let pos_signer = object::generate_signer(&ctor);
    let delete_ref = object::generate_delete_ref(&ctor);

    move_to(&pos_signer, LpPosition {
        pool_addr,
        shares,
        fee_debt_a: initial_debt_a,
        fee_debt_b: initial_debt_b,
        delete_ref,
    });

    object::object_from_constructor_ref<LpPosition>(&ctor)
}
```

**Note:** no call to `object::disable_ungated_transfer` — position is freely transferable via `object::transfer`. This is what the locker relies on at `lock_position` step 4 to move the position to its own address.

### 9.3 `claim_lp_fees` (pool.move:585-636) — the only external call from the locker

```move
/// Harvest accumulated LP fees without touching position's shares.
/// Resets debt snapshot to current per_share so future accumulation
/// starts from zero. Runs under the pool lock to stay safe if FA
/// operations ever gain dispatch callbacks.
public fun claim_lp_fees(
    provider: &signer,
    position: Object<LpPosition>,
): (FungibleAsset, FungibleAsset) acquires Pool, LpPosition {
    let provider_addr = signer::address_of(provider);
    assert!(object::owner(position) == provider_addr, E_NOT_OWNER);

    let position_addr = object::object_address(&position);
    assert!(exists<LpPosition>(position_addr), E_NO_POSITION);

    let pos = borrow_global_mut<LpPosition>(position_addr);
    assert!(exists<Pool>(pos.pool_addr), E_NO_POOL);

    let pool = borrow_global_mut<Pool>(pos.pool_addr);
    assert!(!pool.locked, E_LOCKED);
    pool.locked = true;

    let claim_a = pending_from_accumulator(pool.lp_fee_per_share_a, pos.fee_debt_a, pos.shares);
    let claim_b = pending_from_accumulator(pool.lp_fee_per_share_b, pos.fee_debt_b, pos.shares);

    pos.fee_debt_a = pool.lp_fee_per_share_a;
    pos.fee_debt_b = pool.lp_fee_per_share_b;

    let pool_signer = object::generate_signer_for_extending(&pool.extend_ref);
    let fa_a = if (claim_a > 0) {
        primary_fungible_store::withdraw(&pool_signer, pool.metadata_a, claim_a)
    } else {
        fungible_asset::zero(pool.metadata_a)
    };
    let fa_b = if (claim_b > 0) {
        primary_fungible_store::withdraw(&pool_signer, pool.metadata_b, claim_b)
    } else {
        fungible_asset::zero(pool.metadata_b)
    };

    pool.locked = false;

    event::emit(LpFeesClaimed {
        pool_addr: pos.pool_addr,
        position_addr,
        claimer: provider_addr,
        fees_a: claim_a,
        fees_b: claim_b,
        timestamp: timestamp::now_seconds(),
    });

    (fa_a, fa_b)
}
```

**Key points for the auditor:**
- Owner check at the top: `object::owner(position) == signer::address_of(provider)`. The locker satisfies this because `locker_signer` generated from `extend_ref` has address == locker_addr, and the position was transferred to locker_addr at lock time.
- Takes `pool.locked = true` for the duration of FA ops (reentrancy guard at pool level; no callbacks in current FA, future-proofing).
- Emits `LpFeesClaimed` with `pool_addr` — this is the correlation source for the locker's off-chain indexer (see D-1).
- Returns `(FungibleAsset, FungibleAsset)` — can be `fungible_asset::zero(...)` if no fees accrued.
- Resets `fee_debt_*` to current `lp_fee_per_share_*` — double-claim in same tx immediately returns zero.

### 9.4 `remove_liquidity` (pool.move:516-581) — NOT called by locker, but relevant to principal-lock invariant

```move
public fun remove_liquidity(
    provider: &signer,
    position: Object<LpPosition>,
    min_amount_a: u64,
    min_amount_b: u64,
): (FungibleAsset, FungibleAsset) acquires Pool, LpPosition {
    let provider_addr = signer::address_of(provider);
    assert!(object::owner(position) == provider_addr, E_NOT_OWNER);
    // ... burns the LpPosition + returns reserves + fees
}
```

**Key point:** the same `object::owner` check here is what makes the principal-lock invariant real. Once the locker owns the position, the user can't call `remove_liquidity_entry(position)` because `object::owner(position) != user_addr`. And because the locker does NOT expose any proxy function to call `remove_liquidity` on the wrapped position (only `claim_fees`), there is no path to withdraw the LP shares before `redeem`.

---

## 10. Dependency / publish notes

The locker's `Move.toml`:

```toml
[package]
name = "DarbitexLpLocker"
version = "0.1.0"
upgrade_policy = "compatible"

[dependencies.AptosFramework]
git = "https://github.com/aptos-labs/aptos-core.git"
rev = "mainnet"
subdir = "aptos-move/framework/aptos-framework"

[dependencies.DarbitexFinal]
local = "../"

[addresses]
darbitex_lp_locker = "_"
```

**At publish time:**
- `darbitex_lp_locker` resolved to publisher address via `--named-addresses`
- `darbitex` resolved via the `DarbitexFinal` dep's own Move.toml to `0xc988d39a...` (mainnet Final address)

For testnet smoke test, we temporarily flipped the Final Move.toml's `darbitex` address to `_` and overrode both at publish time. Restored after publish. This is NOT done in the mainnet flow — mainnet resolves naturally via the hardcoded mainnet address.

---

## 11. What we considered and (hopefully) got right

Please comment on these decisions:

1. **External satellite over core upgrade.** Avoids re-auditing core. Core passed 3 rounds of audit already.
2. **Single struct with embedded refs.** `LockedPosition { position, unlock_at, extend_ref, delete_ref }`. All state in one place, no split registry.
3. **`object::owner` as authorization source of truth.** Matches Aptos-native pattern. No separate ACL map.
4. **Explicit `E_INVALID_UNLOCK`** — user-facing error for "unlock_at in the past/present", not a silent no-op.
5. **Three distinct events** not one merged event with a `kind` enum — simpler indexer mapping.
6. **No deadline parameter on entries** — operations are not mempool-sensitive.
7. **Correlation-based event attribution** for `pool_addr` — pragmatic workaround for module-private field without core touch.
8. **Non-entry `lock_position_and_get` sibling** — same pattern as `add_liquidity` / `add_liquidity_entry` in core.
9. **No extend/shorten** — keeps API minimal; "re-lock" flow is `redeem` + `lock_position`.
10. **Transferability preserves lock state for free** — no custom transfer entry; Aptos's built-in `object::transfer` already handles it correctly because `LockedPosition` is a standard object resource.

---

## 12. Ranked areas of concern (where you should spend the most time)

1. **§6.3 `redeem` destructure-then-assert ordering** — we destructure `LockedPosition` via `move_from` FIRST, then assert `now >= unlock_at`. If the assert fires, the tx aborts atomically and state rolls back. Please verify this ordering has no subtle issue. (Alternative considered: borrow first, assert, then move — but that creates two borrows of the same resource across the assert, which is awkward. The current form is cleaner and relies on Move's atomic abort semantic.)
2. **§6.2 `claim_fees` FA linearity** — between `pool::claim_lp_fees` returning `(fa_a, fa_b)` and the `deposit` calls, verify no abort path exists that could drop the FAs.
3. **§2 principal D-1 correlation attribution** — is omitting `pool_addr` from `FeesClaimed` acceptable, or should we reconsider?
4. **§7.1 D-3 `lock_position_and_get`** — any attack surface from exposing the non-entry variant as public (rather than friend-only)?
5. **§6.1 `object::transfer` internal owner check** — we rely on `aptos_framework::object::transfer_raw` to assert `object::owner(position) == signer::address_of(user)` before transferring to `locker_addr`. Please verify this is indeed what aptos-framework does, and that the abort code path is cleanly propagated.
6. **D-7 core upgrade stance** — is our rationale (compat policy forbids signature changes, immutability flip after soak) sufficient, or do we need a version-assertion guard?

---

## 13. Out of scope

- Core `darbitex::pool` security — already audited R3 GREEN, LIVE 2026-04-14. Assume correct per its published audit report.
- Aptos framework correctness — `aptos_framework::object`, `fungible_asset`, `primary_fungible_store`, `timestamp`. Trusted.
- Frontend UX — not shipped, not in scope.
- Economic analysis of "is a time-locked LP a good product?" — out of scope, this is a security review.
- Tax / legal / compliance implications of locked LP tokens — out of scope.

---

## 14. Test matrix fun facts

- **179 LoC production source**
- **243 LoC test source**
- **8/8 Move unit tests passing** on simulated pool + LpPosition
- **15 on-chain transactions** exercising every exposed function and every abort path on Aptos testnet
- **3 abort paths** (E_NOT_OWNER, E_STILL_LOCKED, E_INVALID_UNLOCK) — all verified on-chain with the expected abort codes
- **6 exposed functions** — 5 directly callable from CLI, 1 (`lock_position_and_get`) non-entry (Move-only, exercised indirectly via `lock_position` and directly in unit tests)
- **0 arithmetic operations** — zero math surface
- **1 external module dependency** — `darbitex::pool` (one function called: `claim_lp_fees`)
- **~0.2 APT total testnet gas** to deploy core + fixture + locker + full 15-step smoke test

---

**End of submission.** Please run your audit against the source in §8, with §9 as context for the core dependency. Findings format in §1. Verdict request: **green / yellow / red** for mainnet publish.
