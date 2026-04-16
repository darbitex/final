import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useState } from "react";
import { FACTORY_PACKAGE } from "../config";
import { createRpcPool } from "../chain/rpc-pool";
import { useAddress } from "../wallet/useConnect";

const rpc = createRpcPool("factory");

const FEE_TABLE = [
  { len: "1 char", fee: "1,000 APT" },
  { len: "2 chars", fee: "100 APT" },
  { len: "3 chars", fee: "10 APT" },
  { len: "4 chars", fee: "1 APT" },
  { len: "5+ chars", fee: "0.1 APT" },
];

function feeForLength(len: number): string {
  if (len === 0) return "—";
  if (len === 1) return "1,000 APT";
  if (len === 2) return "100 APT";
  if (len === 3) return "10 APT";
  if (len === 4) return "1 APT";
  return "0.1 APT";
}

function isAsciiPrintable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

export function FactoryPage() {
  const address = useAddress();
  const { signAndSubmitTransaction } = useWallet();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<{ text: string; error: boolean } | null>(null);

  const [lookupSymbol, setLookupSymbol] = useState("");
  const [lookupResult, setLookupResult] = useState<{
    exists: boolean;
    addr: string;
    symbol: string;
  } | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  const symbolValid = symbol.length > 0 && isAsciiPrintable(symbol);
  const nameValid = name.length > 0;
  const canCreate = address && nameValid && symbolValid && !creating;

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setCreating(true);
    setCreateMsg(null);
    try {
      const result = await signAndSubmitTransaction({
        data: {
          function: `${FACTORY_PACKAGE}::token::create_token`,
          typeArguments: [],
          functionArguments: [
            new TextEncoder().encode(name),
            new TextEncoder().encode(symbol),
          ],
        },
      });
      setCreateMsg({
        text: `Token created: ${result.hash.slice(0, 12)}…`,
        error: false,
      });
      setName("");
      setSymbol("");
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("EOBJECT_EXISTS")) {
        setCreateMsg({ text: `Symbol "${symbol}" is already taken.`, error: true });
      } else if (msg.includes("E_INVALID_SYMBOL") || msg.includes("0x6")) {
        setCreateMsg({ text: "Symbol must be ASCII printable characters only (no spaces, emoji, or unicode).", error: true });
      } else {
        setCreateMsg({ text: msg, error: true });
      }
    } finally {
      setCreating(false);
    }
  }, [canCreate, name, symbol, signAndSubmitTransaction]);

  const handleLookup = useCallback(async () => {
    if (!lookupSymbol) return;
    setLookingUp(true);
    setLookupResult(null);
    try {
      const [existsRes, addrRes] = await Promise.all([
        rpc.rotatedView<[boolean]>({
          function: `${FACTORY_PACKAGE}::token::token_exists`,
          typeArguments: [],
          functionArguments: [lookupSymbol],
        }),
        rpc.rotatedView<[string]>({
          function: `${FACTORY_PACKAGE}::token::token_address`,
          typeArguments: [],
          functionArguments: [lookupSymbol],
        }),
      ]);
      setLookupResult({
        exists: existsRes[0],
        addr: addrRes[0],
        symbol: lookupSymbol,
      });
    } catch {
      setLookupResult(null);
    } finally {
      setLookingUp(false);
    }
  }, [lookupSymbol]);

  if (!address) {
    return (
      <div className="container">
        <h1 className="page-title">Token Factory</h1>
        <p className="page-sub">Connect your wallet to create tokens.</p>
      </div>
    );
  }

  return (
    <div className="container">
      <h1 className="page-title">Token Factory</h1>
      <p className="page-sub">
        Create your own token on Aptos. Standard Fungible Asset, fully composable
        with all DEXs, wallets, and bridges. Fixed 1B supply, 8 decimals.
      </p>

      {/* ===== Create Token ===== */}
      <div className="card factory-card">
        <h2 className="section-title">Create Token</h2>

        <label className="factory-label">
          Name
          <input
            type="text"
            className="factory-input"
            placeholder="e.g. Decentralized Arbitrage Exchange"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
          />
        </label>

        <label className="factory-label">
          Symbol / Ticker
          <input
            type="text"
            className="factory-input"
            placeholder="e.g. DARBITEX"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            maxLength={32}
          />
        </label>

        {symbol.length > 0 && !isAsciiPrintable(symbol) && (
          <div className="err" style={{ fontSize: 12, marginTop: 4 }}>
            Symbol must be ASCII printable characters only.
          </div>
        )}

        <div className="factory-fee-display">
          <span className="dim">Creation fee:</span>
          <strong>{feeForLength(symbol.length)}</strong>
        </div>

        <div className="factory-fee-table">
          {FEE_TABLE.map((r) => (
            <div key={r.len} className="factory-fee-row">
              <span className="dim">{r.len}</span>
              <span>{r.fee}</span>
            </div>
          ))}
        </div>

        <div className="factory-specs">
          <div><span className="dim">Supply</span> <strong>1,000,000,000</strong> (fixed, no future minting)</div>
          <div><span className="dim">Decimals</span> <strong>8</strong></div>
          <div><span className="dim">Burn</span> <strong>Enabled</strong> (self-burn only)</div>
        </div>

        <div className="lock-warning">
          <strong>Before you create:</strong>
          <ul>
            <li>Total supply is fixed at 1B. <strong>No additional tokens can ever be minted.</strong></li>
            <li>The creation fee is non-refundable.</li>
            <li>Symbol is permanently reserved — no one can create another token with the same symbol.</li>
            <li>Token metadata (name, symbol, decimals) <strong>cannot be changed</strong> after creation.</li>
          </ul>
        </div>

        <button
          type="button"
          className="btn btn-primary"
          style={{ width: "100%", marginTop: 12 }}
          disabled={!canCreate}
          onClick={handleCreate}
        >
          {creating ? "Creating…" : `Create Token (${feeForLength(symbol.length)})`}
        </button>

        {createMsg && (
          <div className={`modal-status ${createMsg.error ? "error" : ""}`}>
            {createMsg.text}
          </div>
        )}
      </div>

      {/* ===== Token Lookup ===== */}
      <div className="card factory-card" style={{ marginTop: 20 }}>
        <h2 className="section-title">Lookup Token</h2>
        <div className="factory-lookup-row">
          <input
            type="text"
            className="factory-input"
            placeholder="Enter symbol..."
            value={lookupSymbol}
            onChange={(e) => setLookupSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleLookup}
            disabled={!lookupSymbol || lookingUp}
          >
            {lookingUp ? "…" : "Search"}
          </button>
        </div>
        {lookupResult && (
          <div className="factory-lookup-result">
            {lookupResult.exists ? (
              <>
                <span className="lookup-badge lookup-taken">TAKEN</span>
                <span className="dim">{lookupResult.symbol}</span>
                <a
                  href={`https://explorer.aptoslabs.com/object/${lookupResult.addr}?network=mainnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {lookupResult.addr.slice(0, 14)}…{lookupResult.addr.slice(-6)}
                </a>
              </>
            ) : (
              <>
                <span className="lookup-badge lookup-available">AVAILABLE</span>
                <span>{lookupResult.symbol} — ready to create</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
