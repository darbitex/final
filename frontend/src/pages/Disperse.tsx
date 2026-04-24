import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useMemo, useState } from "react";
import {
  DISPERSE_FEE_CONFIRM_THRESHOLD_OCTAS,
  DISPERSE_FEE_OCTAS,
  DISPERSE_MAX_PER_TX,
  DISPERSE_PACKAGE,
  GEOMI_API_KEY,
  TOKENS,
} from "../config";
import { fetchFaMetadata } from "../chain/balance";
import { createRpcPool } from "../chain/rpc-pool";
import { TokenIcon } from "../components/TokenIcon";
import { useAddress } from "../wallet/useConnect";

const CUSTOM_KEY = "__custom__";

const rpc = createRpcPool("disperse");

const INDEXER_URL = "https://api.mainnet.aptoslabs.com/v1/graphql";

type Source = "csv" | "fa" | "nft";
type Mode = "uniform" | "custom" | "proportional";
type Row = { address: string; amount: bigint };

// Recipient carries an optional "weight" alongside the editable airdrop
// amount. Weight is the source-side signal — raw FA balance for FA-holder
// sourcing, NFT count for NFT-holder sourcing, undefined for CSV rows
// (CSV has no weighting context). Proportional mode distributes a user-
// specified total by weight; Custom mode surfaces weight as "holds: X"
// next to each inline amount input.
type Recipient = {
  address: string;
  amount?: string;
  weightRaw?: string;
  weightDecimals?: number;
  weightSymbol?: string;
};

function normAddr(s: string) {
  if (!s.startsWith("0x")) return null;
  const hex = s.slice(2).toLowerCase();
  if (!/^[0-9a-f]{1,64}$/.test(hex)) return null;
  return "0x" + hex.padStart(64, "0");
}

function parseUnits(s: string, decimals: number): bigint {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`invalid number: "${s}"`);
  const [whole, frac = ""] = t.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || 0);
}

function formatUnits(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function parseCsv(
  text: string,
): { rows: { address: string; amount?: string }[]; errors: string[]; dupCount: number } {
  const rows: { address: string; amount?: string }[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let dupCount = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const cols = raw.split(/[,\t;]/).map((c) => c.trim());
    const addr = normAddr(cols[0] || "");
    if (!addr) {
      errors.push(`line ${i + 1}: invalid address "${cols[0]}"`);
      continue;
    }
    if (seen.has(addr)) dupCount++;
    seen.add(addr);
    rows.push({ address: addr, amount: cols[1] });
  }
  return { rows, errors, dupCount };
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await fetch(INDEXER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${GEOMI_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`indexer ${r.status}`);
  const j = (await r.json()) as { data?: T; errors?: { message: string }[] };
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data as T;
}

async function fetchFaHolders(
  meta: string,
  minBalance: bigint,
): Promise<{ address: string; balance: bigint }[]> {
  const query = `
    query($m:String!, $limit:Int!, $offset:Int!) {
      current_fungible_asset_balances(
        where: { asset_type: { _eq: $m }, amount: { _gt: "0" } }
        limit: $limit, offset: $offset, order_by: { amount: desc }
      ) { owner_address amount }
    }`;
  const byAddr = new Map<string, bigint>();
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const d = await graphql<{ current_fungible_asset_balances: { owner_address: string; amount: string }[] }>(
      query,
      { m: meta, limit: 1000, offset },
    );
    const rows = d.current_fungible_asset_balances;
    if (!rows.length) break;
    for (const r of rows) {
      const amt = BigInt(r.amount);
      if (amt < minBalance) continue;
      byAddr.set(r.owner_address, (byAddr.get(r.owner_address) ?? 0n) + amt);
    }
    if (rows.length < 1000) break;
  }
  return Array.from(byAddr.entries())
    .map(([address, balance]) => ({ address, balance }))
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
}

async function fetchNftHolders(
  collectionId: string,
): Promise<{ address: string; count: bigint }[]> {
  const query = `
    query($c:String!, $limit:Int!, $offset:Int!) {
      current_token_ownerships_v2(
        where: { current_token_data: { collection_id: { _eq: $c } }, amount: { _gt: 0 } }
        limit: $limit, offset: $offset
      ) { owner_address amount }
    }`;
  const byAddr = new Map<string, bigint>();
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const d = await graphql<{ current_token_ownerships_v2: { owner_address: string; amount: number | string }[] }>(
      query,
      { c: collectionId, limit: 1000, offset },
    );
    const rows = d.current_token_ownerships_v2;
    if (!rows.length) break;
    for (const r of rows) {
      const n = BigInt(String(r.amount ?? "1"));
      byAddr.set(r.owner_address, (byAddr.get(r.owner_address) ?? 0n) + n);
    }
    if (rows.length < 1000) break;
  }
  return Array.from(byAddr.entries())
    .map(([address, count]) => ({ address, count }))
    .sort((a, b) => (b.count > a.count ? 1 : b.count < a.count ? -1 : 0));
}

async function resolveCustomToken(
  meta: string,
): Promise<{ symbol: string; decimals: number } | null> {
  try {
    const [symbol] = await rpc.rotatedView<[string]>({
      function: "0x1::fungible_asset::symbol",
      typeArguments: [],
      functionArguments: [meta],
    });
    const [decimalsRaw] = await rpc.rotatedView<[string | number]>({
      function: "0x1::fungible_asset::decimals",
      typeArguments: [],
      functionArguments: [meta],
    });
    return { symbol, decimals: Number(decimalsRaw) };
  } catch {
    return null;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function DisperseBody() {
  const address = useAddress();
  const { signAndSubmitTransaction } = useWallet();

  const [source, setSource] = useState<Source>("csv");
  const [csvText, setCsvText] = useState("");
  const [faMetaInput, setFaMetaInput] = useState("");
  const [faMinBalance, setFaMinBalance] = useState("1");
  const [nftCollectionInput, setNftCollectionInput] = useState("");

  const [tokenKey, setTokenKey] = useState<string>("APT");
  const [customAddr, setCustomAddr] = useState("");
  const [customInfo, setCustomInfo] = useState<{ symbol: string; decimals: number } | null>(null);
  const [resolvingCustom, setResolvingCustom] = useState(false);

  const tokenMeta = useMemo(() => {
    if (tokenKey === CUSTOM_KEY) return customInfo ? normAddr(customAddr.trim()) : null;
    return TOKENS[tokenKey]?.meta ?? null;
  }, [tokenKey, customAddr, customInfo]);
  const decimals = useMemo<number | null>(() => {
    if (tokenKey === CUSTOM_KEY) return customInfo?.decimals ?? null;
    return TOKENS[tokenKey]?.decimals ?? null;
  }, [tokenKey, customInfo]);
  const tokenSymbol = useMemo(() => {
    if (tokenKey === CUSTOM_KEY) return customInfo?.symbol ?? "?";
    return TOKENS[tokenKey]?.symbol ?? "?";
  }, [tokenKey, customInfo]);

  const [mode, setMode] = useState<Mode>("uniform");
  const [uniformAmount, setUniformAmount] = useState("");
  const [proportionalTotal, setProportionalTotal] = useState("");

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [fetchingSource, setFetchingSource] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; tx?: string } | null>(null);
  const [result, setResult] = useState<{ text: string; error: boolean; hashes?: string[] } | null>(null);

  // ---- Source handlers ----
  const handleParseCsv = useCallback(() => {
    setSourceError(null);
    const { rows, errors, dupCount } = parseCsv(csvText);
    const notes: string[] = [];
    if (errors.length)
      notes.push(errors.slice(0, 5).join("\n") + (errors.length > 5 ? `\n... +${errors.length - 5} more` : ""));
    if (dupCount > 0)
      notes.push(`⚠ ${dupCount} duplicate address${dupCount > 1 ? "es" : ""} detected — they will each receive separately.`);
    if (notes.length) setSourceError(notes.join("\n"));
    setRecipients(rows);
    const hasAmounts = rows.length > 0 && rows.every((r) => r.amount && r.amount.length > 0);
    setMode(hasAmounts ? "custom" : "uniform");
  }, [csvText]);

  const handleFetchFa = useCallback(async () => {
    const m = normAddr(faMetaInput);
    if (!m) {
      setSourceError("invalid FA metadata address");
      return;
    }
    setFetchingSource(true);
    setSourceError(null);
    try {
      const srcMeta = await fetchFaMetadata(m);
      if (!srcMeta) {
        setSourceError("source FA metadata not resolvable");
        return;
      }
      const holders = await fetchFaHolders(m, BigInt(faMinBalance || "1"));
      // Pre-fill `amount` with the human-readable holding so Custom mode
      // surfaces a starting value (user scales/edits), and populate weight
      // fields so Proportional mode has something to distribute by.
      setRecipients(
        holders.map((h) => ({
          address: h.address,
          amount: formatUnits(h.balance, srcMeta.decimals),
          weightRaw: h.balance.toString(),
          weightDecimals: srcMeta.decimals,
          weightSymbol: srcMeta.symbol,
        })),
      );
      setMode("custom");
    } catch (e) {
      setSourceError((e as Error).message);
    } finally {
      setFetchingSource(false);
    }
  }, [faMetaInput, faMinBalance]);

  const handleFetchNft = useCallback(async () => {
    if (!nftCollectionInput.trim()) {
      setSourceError("collection id required");
      return;
    }
    setFetchingSource(true);
    setSourceError(null);
    try {
      const holders = await fetchNftHolders(nftCollectionInput.trim());
      // Weight = NFT count (integer, 0 decimals). Pre-fill amount with the
      // count so Custom mode shows a starting value; holders with 3 NFTs
      // default to "3", 1-NFT holders to "1" — user scales across the
      // whole list or per-row as they like.
      setRecipients(
        holders.map((h) => ({
          address: h.address,
          amount: h.count.toString(),
          weightRaw: h.count.toString(),
          weightDecimals: 0,
          weightSymbol: "NFT",
        })),
      );
      setMode("custom");
    } catch (e) {
      setSourceError((e as Error).message);
    } finally {
      setFetchingSource(false);
    }
  }, [nftCollectionInput]);

  const handleCustomAddrChange = useCallback(async (addr: string) => {
    setCustomAddr(addr);
    setCustomInfo(null);
    const trimmed = addr.trim();
    const m = normAddr(trimmed);
    if (!m) return;
    setResolvingCustom(true);
    const info = await resolveCustomToken(m);
    setCustomInfo(info);
    setResolvingCustom(false);
  }, []);

  // ---- Derived summary ----
  const hasWeights = useMemo(
    () => recipients.length > 0 && recipients.every((r) => r.weightRaw !== undefined),
    [recipients],
  );

  const summary = useMemo(() => {
    if (recipients.length === 0 || decimals === null) return null;
    try {
      let rows: Row[];
      if (mode === "uniform") {
        if (!uniformAmount) return null;
        const amt = parseUnits(uniformAmount, decimals);
        if (amt <= 0n) return null;
        rows = recipients.map((r) => ({ address: r.address, amount: amt }));
      } else if (mode === "proportional") {
        if (!proportionalTotal || !hasWeights) return null;
        const totalRaw = parseUnits(proportionalTotal, decimals);
        if (totalRaw <= 0n) return null;
        // Sum weights as bigint; distribute totalRaw * weight[i] / sumWeight.
        // Rounding dust accumulates on the last row so ∑rows = totalRaw exactly.
        const weights = recipients.map((r) => BigInt(r.weightRaw!));
        const sumW = weights.reduce((a, w) => a + w, 0n);
        if (sumW === 0n) return null;
        const amounts = weights.map((w) => (totalRaw * w) / sumW);
        const consumed = amounts.reduce((a, x) => a + x, 0n);
        if (amounts.length > 0) amounts[amounts.length - 1] += totalRaw - consumed;
        rows = recipients.map((r, i) => ({ address: r.address, amount: amounts[i] }));
        for (const r of rows) if (r.amount <= 0n) return null;
      } else {
        // custom — each row takes its own `amount` string
        rows = recipients.map((r) => ({
          address: r.address,
          amount: parseUnits(r.amount || "0", decimals),
        }));
        for (const r of rows) if (r.amount <= 0n) return null;
      }
      const total = rows.reduce((a, r) => a + r.amount, 0n);
      const batches = Math.ceil(rows.length / DISPERSE_MAX_PER_TX);
      const feeTotalOctas = DISPERSE_FEE_OCTAS * BigInt(batches);
      return { rows, total, batches, feeTotalOctas };
    } catch {
      return null;
    }
  }, [recipients, mode, uniformAmount, proportionalTotal, decimals, hasWeights]);

  // ---- Submit ----
  const handleSubmit = useCallback(async () => {
    if (!summary || !address || submitting) return;
    const meta = tokenMeta;
    if (!meta) return;
    if (summary.feeTotalOctas >= DISPERSE_FEE_CONFIRM_THRESHOLD_OCTAS) {
      const ok = window.confirm(
        `This will charge ${formatUnits(summary.feeTotalOctas, 8)} APT in protocol fees across ${summary.batches} batches. Continue?`,
      );
      if (!ok) return;
    }
    setSubmitting(true);
    setResult(null);
    setProgress({ done: 0, total: summary.rows.length });
    const hashes: string[] = [];
    try {
      const batches = chunk(summary.rows, DISPERSE_MAX_PER_TX);
      let done = 0;
      for (const batch of batches) {
        const fn =
          mode === "uniform"
            ? `${DISPERSE_PACKAGE}::disperse::disperse_uniform`
            : `${DISPERSE_PACKAGE}::disperse::disperse_custom`;
        const args =
          mode === "uniform"
            ? [meta, batch.map((r) => r.address), batch[0].amount.toString()]
            : [meta, batch.map((r) => r.address), batch.map((r) => r.amount.toString())];
        const tx = await signAndSubmitTransaction({
          data: { function: fn, typeArguments: [], functionArguments: args },
        });
        hashes.push(tx.hash);
        done += batch.length;
        setProgress({ done, total: summary.rows.length, tx: tx.hash });
      }
      setResult({
        text: `Dispersed to ${summary.rows.length} recipients across ${batches.length} batch${batches.length > 1 ? "es" : ""}.`,
        error: false,
        hashes,
      });
    } catch (e) {
      setResult({
        text: `Failed after ${progress?.done ?? 0} recipients: ${(e as Error).message}`,
        error: true,
        hashes,
      });
    } finally {
      setSubmitting(false);
    }
  }, [summary, address, submitting, tokenMeta, mode, signAndSubmitTransaction, progress?.done]);

  if (!address) {
    return (
      <p className="page-sub">Connect your wallet to airdrop fungible assets to many addresses in one go.</p>
    );
  }

  return (
    <>
      <p className="page-sub">
        Bulk send any Aptos FA to many recipients. Flat <strong>1 APT</strong> protocol fee per tx, batches of up to{" "}
        <strong>{DISPERSE_MAX_PER_TX}</strong> recipients.
      </p>

      {/* ===== Source ===== */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="mode-tabs">
          {(["csv", "fa", "nft"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={source === s ? "active" : ""}
              onClick={() => {
                setSource(s);
                setRecipients([]);
                setSourceError(null);
              }}
            >
              {s === "csv" ? "CSV" : s === "fa" ? "FA holders" : "NFT holders"}
            </button>
          ))}
        </div>

        {source === "csv" && (
          <>
            <label className="factory-label">
              Recipients (one per line)
              <div style={{ fontSize: 11, color: "#777", marginTop: 2, fontWeight: 400 }}>
                Paste just addresses and set a uniform amount below, OR add{" "}
                <code>,amount</code> per line to send a different amount to each recipient.
              </div>
              <textarea
                className="factory-input"
                rows={8}
                placeholder={"0xabc...        # uses uniform amount\n0xdef...,250.5  # this row gets 250.5\n# lines starting with # are comments"}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                style={{ fontFamily: "monospace", fontSize: 12 }}
              />
            </label>
            <button type="button" className="btn btn-secondary" onClick={handleParseCsv} disabled={!csvText.trim()}>
              Parse
            </button>
          </>
        )}

        {source === "fa" && (
          <>
            <label className="factory-label">
              FA metadata address
              <input
                type="text"
                className="factory-input"
                placeholder="0x..."
                value={faMetaInput}
                onChange={(e) => setFaMetaInput(e.target.value)}
              />
            </label>
            <label className="factory-label">
              Minimum balance (raw units, excludes holders below this)
              <input
                type="text"
                className="factory-input"
                value={faMinBalance}
                onChange={(e) => setFaMinBalance(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleFetchFa}
              disabled={!faMetaInput || fetchingSource}
            >
              {fetchingSource ? "Fetching…" : "Fetch holders"}
            </button>
          </>
        )}

        {source === "nft" && (
          <>
            <label className="factory-label">
              Collection ID (0x…)
              <input
                type="text"
                className="factory-input"
                placeholder="0x..."
                value={nftCollectionInput}
                onChange={(e) => setNftCollectionInput(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleFetchNft}
              disabled={!nftCollectionInput || fetchingSource}
            >
              {fetchingSource ? "Fetching…" : "Fetch owners"}
            </button>
          </>
        )}

        {sourceError && (
          <div className="err" style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 8 }}>
            {sourceError}
          </div>
        )}
      </div>

      {/* ===== Distribution ===== */}
      {recipients.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 className="section-title">Distribution</h2>

          <label className="factory-label">
            Token to airdrop
            <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              {tokenKey !== CUSTOM_KEY && TOKENS[tokenKey] ? (
                <TokenIcon token={TOKENS[tokenKey]} size={20} />
              ) : customInfo ? (
                <TokenIcon token={{ symbol: customInfo.symbol }} size={20} />
              ) : null}
              <select
                className="factory-input"
                style={{ marginTop: 0, flex: 1 }}
                value={tokenKey}
                onChange={(e) => setTokenKey(e.target.value)}
              >
                {Object.entries(TOKENS).map(([k, t]) => (
                  <option key={k} value={k}>
                    {t.symbol}
                  </option>
                ))}
                <option value={CUSTOM_KEY}>Custom token…</option>
              </select>
            </span>
          </label>
          {tokenKey === CUSTOM_KEY && (
            <>
              <label className="factory-label">
                FA metadata address
                <input
                  type="text"
                  className="factory-input"
                  placeholder="0x... (the FA metadata object address)"
                  value={customAddr}
                  onChange={(e) => handleCustomAddrChange(e.target.value)}
                />
              </label>
              {customAddr && customInfo && (
                <div style={{ fontSize: 11, color: "#00cc55", marginTop: 4 }}>
                  {customInfo.symbol} ({customInfo.decimals} decimals)
                </div>
              )}
              {customAddr && !customInfo && !resolvingCustom && customAddr.length > 10 && (
                <div className="err" style={{ fontSize: 11, marginTop: 4 }}>
                  Not a valid FA metadata address.
                </div>
              )}
              {resolvingCustom && (
                <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                  resolving…
                </div>
              )}
            </>
          )}

          <div className="mode-tabs" style={{ marginTop: 12 }}>
            <button
              type="button"
              className={mode === "uniform" ? "active" : ""}
              onClick={() => setMode("uniform")}
            >
              Same for all
            </button>
            <button
              type="button"
              className={mode === "custom" ? "active" : ""}
              onClick={() => setMode("custom")}
            >
              Custom per recipient
            </button>
            <button
              type="button"
              className={mode === "proportional" ? "active" : ""}
              onClick={() => setMode("proportional")}
              disabled={!hasWeights}
              title={
                hasWeights
                  ? undefined
                  : "Proportional mode needs weights — use the FA holders or NFT holders source"
              }
            >
              Proportional to holdings
            </button>
          </div>

          {mode === "uniform" && (
            <label className="factory-label" style={{ marginTop: 12 }}>
              Amount (sent to every recipient)
              <input
                type="text"
                className="factory-input"
                placeholder="e.g. 100"
                value={uniformAmount}
                onChange={(e) => setUniformAmount(e.target.value)}
              />
            </label>
          )}

          {mode === "proportional" && hasWeights && (
            <div style={{ marginTop: 12 }}>
              <label className="factory-label">
                Total to distribute (split by each holder's weight)
                <input
                  type="text"
                  className="factory-input"
                  placeholder="e.g. 10000"
                  value={proportionalTotal}
                  onChange={(e) => setProportionalTotal(e.target.value)}
                />
              </label>
              <div style={{ fontSize: 11, color: "#999", marginTop: 6 }}>
                Each recipient receives{" "}
                <code>total × weight / Σ weights</code>. Rounding dust goes to
                the last row so the sum equals the total exactly.
              </div>
            </div>
          )}

          {mode === "custom" && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "#999", marginBottom: 6 }}>
                Amount per recipient ({recipients.length} total) &mdash; edit inline
                {hasWeights && " · holdings pre-filled from source, edit or scale freely"}
                :
              </div>
              <div
                style={{
                  maxHeight: 260,
                  overflowY: "auto",
                  border: "1px solid #1a1a1a",
                  borderRadius: 4,
                  padding: 6,
                }}
              >
                {recipients.map((r, i) => {
                  const weightLabel =
                    r.weightRaw !== undefined
                      ? `holds: ${formatUnits(
                          BigInt(r.weightRaw),
                          r.weightDecimals ?? 0,
                        )}${r.weightSymbol ? " " + r.weightSymbol : ""}`
                      : null;
                  return (
                    <div
                      key={`${r.address}-${i}`}
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        padding: "4px 0",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "monospace",
                          fontSize: 11,
                          color: "#aaa",
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={r.address}
                      >
                        {r.address.slice(0, 10)}…{r.address.slice(-6)}
                      </span>
                      {weightLabel && (
                        <span
                          style={{
                            fontSize: 10,
                            color: "#666",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {weightLabel}
                        </span>
                      )}
                      <input
                        type="text"
                        className="factory-input"
                        style={{ width: 120, marginTop: 0, fontSize: 12 }}
                        placeholder="amount"
                        value={r.amount ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setRecipients((prev) =>
                            prev.map((p, idx) =>
                              idx === i ? { ...p, amount: v } : p,
                            ),
                          );
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== Preview + Submit ===== */}
      {summary && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 className="section-title">Preview</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <span className="dim">Recipients</span>{" "}
              <strong>{summary.rows.length.toLocaleString()}</strong>
            </div>
            <div>
              <span className="dim">Batches (max {DISPERSE_MAX_PER_TX}/tx)</span>{" "}
              <strong>{summary.batches}</strong>
            </div>
            <div>
              <span className="dim">Total amount</span>{" "}
              <strong>{formatUnits(summary.total, decimals ?? 0)}</strong>
            </div>
            <div>
              <span className="dim">Total protocol fee</span>{" "}
              <strong>{formatUnits(summary.feeTotalOctas, 8)} APT</strong>
            </div>
          </div>

          <div
            style={{
              maxHeight: 220,
              overflowY: "auto",
              border: "1px solid #1a1a1a",
              borderRadius: 4,
              padding: 8,
              fontFamily: "monospace",
              fontSize: 11,
            }}
          >
            {summary.rows.slice(0, 100).map((r) => (
              <div key={r.address} style={{ display: "flex", justifyContent: "space-between" }}>
                <span>
                  {r.address.slice(0, 10)}…{r.address.slice(-6)}
                </span>
                <span>{formatUnits(r.amount, decimals ?? 0)}</span>
              </div>
            ))}
            {summary.rows.length > 100 && (
              <div className="dim" style={{ textAlign: "center", marginTop: 6 }}>
                … and {summary.rows.length - 100} more
              </div>
            )}
          </div>

          <button
            type="button"
            className="btn btn-primary"
            style={{ width: "100%", marginTop: 12 }}
            disabled={submitting || !tokenMeta}
            onClick={handleSubmit}
          >
            {submitting
              ? `Sending… ${progress?.done ?? 0}/${progress?.total ?? 0}`
              : `Disperse ${tokenSymbol} (fee ${formatUnits(summary.feeTotalOctas, 8)} APT)`}
          </button>

          {progress && (
            <div
              style={{
                marginTop: 8,
                height: 4,
                background: "#1a1a1a",
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${(progress.done / Math.max(1, progress.total)) * 100}%`,
                  background: "#ff8800",
                  transition: "width 0.3s",
                }}
              />
            </div>
          )}

          {result && (
            <div className={`modal-status ${result.error ? "error" : ""}`} style={{ marginTop: 8 }}>
              <div>{result.text}</div>
              {result.hashes && result.hashes.length > 0 && (
                <div style={{ fontSize: 11, marginTop: 4 }}>
                  {result.hashes.map((h) => (
                    <a
                      key={h}
                      href={`https://explorer.aptoslabs.com/txn/${h}?network=mainnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ display: "block" }}
                    >
                      {h.slice(0, 14)}…{h.slice(-6)}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
