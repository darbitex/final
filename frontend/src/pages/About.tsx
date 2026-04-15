export function AboutPage() {
  return (
    <div className="container about">
      <h1 className="page-title">About</h1>
      <p className="tagline">
        Decentralized Arbitrage Exchange — surplus-fee AMM on Aptos
      </p>

      <div className="about-grid">
        <div className="about-stat">
          <div className="big">1</div>
          <div className="label">BPS LP FEE</div>
        </div>
        <div className="about-stat">
          <div className="big">3</div>
          <div className="label">CORE MODULES</div>
        </div>
        <div className="about-stat">
          <div className="big">13</div>
          <div className="label">AUDIT PASSES</div>
        </div>
        <div className="about-stat">
          <div className="big">0</div>
          <div className="label">ADMIN FUNCTIONS</div>
        </div>
      </div>

      <h2 className="section-title">What is Darbitex?</h2>
      <p>
        Darbitex is a <strong>two-layer AMM</strong> on Aptos. The bottom layer is a
        boring, immutable <code>x × y = k</code> pool. The top layer is{" "}
        <code>arbitrage</code>, a composable middleware module that wraps the pool with
        smart routing, real-capital cycle closure, and flash-loan triangle arbitrage. The
        protocol keeps 10% of measurable surplus — and nothing when there is no surplus
        to tax.
      </p>

      <h2 className="section-title">How it works — the short version</h2>
      <p>
        Think of two counters at a shop.
      </p>
      <p>
        <strong>Counter 1 — the pool.</strong> A vending machine. You put 1 APT in, you
        get the exact amount of USDC the <code>x × y = k</code> curve says you get, minus
        a 1 bps fee that goes entirely to the LPs who stocked the machine. It has no
        opinions, no strategies, no callbacks, no admin. It is a pure primitive and it
        never changes.
      </p>
      <p>
        <strong>Counter 2 — arbitrage.</strong> A smart clerk standing next to the vending
        machine. You hand your APT to the clerk and say "get me USDC". The clerk knows
        about every pool on Darbitex, simulates the direct route and every multi-hop
        route, picks whichever produces more USDC, and hands you the output. If the smart
        route produced more than the direct vending-machine swap would have, the clerk
        keeps 10% of the <em>difference</em> as a tip and gives you the other 90%. If
        there was no difference — you just paid for what you would have gotten anyway —
        the clerk keeps nothing.
      </p>
      <p>
        The clerk also runs a second service: flash-loan triangle arbitrage. Any wallet
        can walk up and say "borrow from pool A, cycle through B → C → A, repay the
        loan". If the cycle lands profitably, 90% of the profit goes to whoever triggered
        it and 10% to the treasury. The trigger is the reward.
      </p>
      <p>
        Every operation is an explicit transaction the caller chose to send. Nothing
        happens behind anyone's back.
      </p>

      <h2 className="section-title">Wrapper over hook injection — why</h2>
      <p>
        An earlier design had the arbitrage logic wired directly into{" "}
        <code>pool::swap</code> as <code>beforeSwap</code> / <code>afterSwap</code>{" "}
        callbacks, in the style of Uniswap V4 hooks. It was abandoned during
        implementation. The shipped wrapper pattern is strictly better on four axes:
      </p>
      <p>
        <strong>1. No reentrancy surface.</strong> Hook callbacks create nested call
        graphs — the pool calls back into the arbitrage module mid-swap, which can call
        back into the pool again. One bug in that chain and the whole thing eats a user's
        funds or bricks every swap. Final's wrapper is a one-way arrow:{" "}
        <code>arbitrage</code> imports <code>pool</code>, never the other way around.
        Nothing inside <code>pool::swap</code> can call out to a module that could call
        back in.
      </p>
      <p>
        <strong>2. Composable by anyone.</strong> With hook injection, adding a new
        arbitrage strategy means upgrading the core pool package — which is gated by
        multisig and breaks audit equity. With the wrapper,{" "}
        <strong>any developer can write their own satellite module</strong> that imports{" "}
        <code>darbitex::pool</code> and composes its Tier-2 primitives
        (<code>swap_compose</code>, <code>execute_path_compose</code>,{" "}
        <code>close_triangle_compose</code>, <code>close_triangle_flash_compose</code>).
        You don't need our permission. You don't need a package upgrade. You ship a new
        module that depends on Darbitex the same way a Rust crate depends on the
        standard library.
      </p>
      <p>
        <strong>3. Opt-in, not tax.</strong> Hook injection taxes every user swap
        whether or not the user wanted the arbitrage service — gas, latency, and
        failure-mode exposure all fall on everyone. The wrapper is pay-for-what-you-use:
        wallets that just want a direct swap pay 1 bps to LPs and nothing else; wallets
        that want smart routing explicitly call <code>arbitrage::swap_entry</code>{" "}
        and pay the 10% surplus only if there was a surplus to capture.
      </p>
      <p>
        <strong>4. Auditable in isolation.</strong> The pool module is {"<"}1K LoC of
        pure AMM math with a linear call graph and no external callouts. An auditor can
        read it end-to-end in an afternoon and know there's nothing hiding behind a
        callback. The arbitrage module can be audited independently without having to
        reason about reentrancy into the pool.
      </p>
      <p>
        <strong>Scope — what the core package actually does today.</strong> The shipped
        Darbitex package provides smart routing, cycle closure, and flash triangles{" "}
        <em>within its own pool graph</em>. Cross-venue routing (Hyperion, Thala,
        Cellana) and cross-venue flash arbitrage are planned as separate{" "}
        <strong>satellite packages</strong> that will compose the Tier-2 primitives
        listed above — they ship as independent deployments, not as upgrades to the core
        package. This is the composability story made concrete: each new strategy is a
        new Move package that depends on Darbitex, not a patch to Darbitex itself.
      </p>
      <p className="mute">
        "Hook" in the Uniswap-V4 sense (runtime callback injected into{" "}
        <code>pool::swap</code>) — Darbitex does not have this. "Hook" in the Move-
        module-composition sense (an opinionated middleware that wraps a primitive) —
        Darbitex is exactly this, and the arbitrage module is the reference
        implementation. Both the pool and arbitrage sources are public on GitHub under
        The Unlicense.
      </p>

      <h2 className="section-title">The 10% rule — only on measurable surplus</h2>
      <p>
        Darbitex charges 10% only on measurable surplus: the delta between what a routed
        trade actually produced and what a direct canonical pool swap would have produced
        for the same input. If the user swaps $1 and receives $1, we take nothing. If the
        user swaps $1 and receives $1.10 thanks to smart routing, we take $0.01.
      </p>
      <p>
        <strong>No baseline = no charge.</strong> If the canonical direct pool doesn't
        exist, there is no reference point, so the entire output goes to the caller.
        Darbitex refuses to tax trades where it is the only available path — a policy
        enforced in code, not convention.
      </p>
      <p>
        The 1 bps swap fee on the underlying pool primitive goes 100% to LPs via a
        MasterChef V2-style per-share accumulator. There is no passive protocol fee slot.
      </p>

      <h2 className="section-title">Prior art</h2>
      <p>
        The surplus-based fee concept is not new — CoW Protocol on Ethereum has charged a
        surplus-based fee since 2024 (50% of quote improvement via an off-chain solver
        auction). Darbitex's economic model is inspired by CoW; what is distinct here is
        the implementation: pure on-chain DFS pathfinding in Move with no solver
        dependency, a 10% rate with no volume floor, and flash-loan triangle closure as a
        first-class user primitive.
      </p>

      <h2 className="section-title">Universal flash loans</h2>
      <p>
        Every pool supports flash loans at the same 1 bps rate. Flash receipts are
        hot-potato structs with no abilities — they must be consumed by{" "}
        <code>flash_repay</code> in the same transaction or the tx aborts.{" "}
        <code>close_triangle_flash</code> uses this internally to close rebalancing cycles
        with zero up-front capital.
      </p>

      <h2 className="section-title">LP as NFT</h2>
      <p>
        LP positions are Aptos objects. <code>add_liquidity</code> uses Uniswap V2
        router-style optimal amount computation — any slippage buffer you provide stays in
        your wallet if it isn't needed. <code>claim_lp_fees</code> harvests accrued fees
        without touching principal, and <code>remove_liquidity</code> burns the position
        for proportional reserves plus unclaimed fees in one shot. Positions are freely
        transferable.
      </p>

      <h2 className="section-title">Audit — 13 passes across 3 rounds</h2>
      <p>
        Final went through 3 audit rounds with 13 independent AI auditor passes: Gemini 2.5
        Pro (R1 + R3), Grok 4, Qwen, Kimi K2 (R1 + R3), DeepSeek (R1 + R3), ChatGPT GPT-5
        (R1 + R2), fresh Claude Opus 4.6 web (R2 + R3), in-session Claude, and Perplexity.
        A total of 14 actionable fixes were applied across the rounds.
      </p>
      <p>
        <strong>Final verdict:</strong> all 5 R3 auditors returned 🟢 GREEN. Gemini — the
        most adversarial auditor throughout — concluded:{" "}
        <em>
          "The architecture is clean, the fallback logic is flawless, and the protection
          mechanisms against both economic manipulation and execution-halting DoS are
          mathematically sound. Proceed to publish."
        </em>
      </p>
      <p className="mute">Audits are aids, not guarantees. Read the code.</p>

      <h2 className="section-title">Fully decentralized</h2>
      <p>
        <strong>Smart contracts</strong> — on Aptos mainnet, published from a 3-of-5
        multisig. Launched under <code>upgrade_policy = "compatible"</code> during a 3–6
        month soak for bug-fix runway. After the soak, upgrade policy flips to{" "}
        <code>immutable</code> — including the hardcoded treasury address and the 10%
        surplus rate, neither of which can ever be retuned.
      </p>
      <p>
        <strong>Frontend</strong> — hosted on Walrus (decentralized storage on Sui).
      </p>
      <p>
        <strong>Backend</strong> — there is none. All state lives on-chain; pools, reserves,
        routes, and quotes are read directly from Aptos RPC.
      </p>
    </div>
  );
}
