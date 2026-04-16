import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Split vendor deps into dedicated chunks so the user's first
        // paint doesn't block on the full bundle. The Aptos SDK +
        // wallet-adapter alone is ~1.5 MB uncompressed — pulling them
        // out lets the main app shell load in ~300-400 KB while the
        // SDK downloads in parallel.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          // Lump all @aptos-labs/* together — ts-sdk and wallet-adapter
          // cross-import each other, so splitting them causes circular
          // chunk warnings. They're both always needed on first paint
          // anyway (wallet connect happens in the header).
          if (id.includes("@aptos-labs/")) return "vendor-aptos";
          // React core (react + react-dom + react-router-dom) in one
          // chunk — these are mutually dependent and tiny compared to
          // Aptos.
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("react-router")
          ) {
            return "vendor-react";
          }
          // Everything else (crypto primitives, polyfills, etc.) goes
          // into the default chunk to avoid circular-import headaches.
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5174,
    strictPort: false,
  },
});
