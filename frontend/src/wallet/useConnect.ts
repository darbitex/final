import { useWallet } from "@aptos-labs/wallet-adapter-react";

export function useAddress(): string | null {
  const { account } = useWallet();
  if (!account) return null;
  const addr = account.address;
  if (typeof addr === "string") return addr;
  if (addr && typeof (addr as { toString: () => string }).toString === "function") {
    return (addr as { toString: () => string }).toString();
  }
  return null;
}
