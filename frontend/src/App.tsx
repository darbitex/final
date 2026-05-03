import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { WalletProvider } from "./wallet/Provider";

// Lazy routes — each page is its own chunk and its own RPC pool. Pages
// that aren't mounted don't contribute any traffic to the per-IP budget.
const TradePage = lazy(() => import("./pages/Trade").then((m) => ({ default: m.TradePage })));
const ArbitragePage = lazy(() =>
  import("./pages/Arbitrage").then((m) => ({ default: m.ArbitragePage })),
);

const Liquidity = lazy(() => import("./pages/Liquidity").then((m) => ({ default: m.Liquidity })));
const PoolsBody = lazy(() => import("./pages/Pools").then((m) => ({ default: m.PoolsBody })));
const PortfolioBody = lazy(() =>
  import("./pages/Portfolio").then((m) => ({ default: m.PortfolioBody })),
);

const Earn = lazy(() => import("./pages/Earn").then((m) => ({ default: m.Earn })));
const VaultBody = lazy(() => import("./pages/Vault").then((m) => ({ default: m.VaultBody })));
const StakingBody = lazy(() => import("./pages/Staking").then((m) => ({ default: m.StakingBody })));

const Tools = lazy(() => import("./pages/Tools").then((m) => ({ default: m.Tools })));
const FactoryBody = lazy(() =>
  import("./pages/Factory").then((m) => ({ default: m.FactoryBody })),
);
const DisperseBody = lazy(() =>
  import("./pages/Disperse").then((m) => ({ default: m.DisperseBody })),
);

const DesnetShell = lazy(() =>
  import("./pages/desnet/Shell").then((m) => ({ default: m.DesnetShell })),
);
const DesnetRegister = lazy(() =>
  import("./pages/desnet/Register").then((m) => ({ default: m.Register })),
);
const DesnetSwap = lazy(() =>
  import("./pages/desnet/Swap").then((m) => ({ default: m.Swap })),
);
const DesnetLiquidity = lazy(() =>
  import("./pages/desnet/Liquidity").then((m) => ({ default: m.Liquidity })),
);
const DesnetPortfolio = lazy(() =>
  import("./pages/desnet/Portfolio").then((m) => ({ default: m.Portfolio })),
);
const DesnetProfileShell = lazy(() =>
  import("./pages/desnet/ProfileShell").then((m) => ({ default: m.ProfileShell })),
);
const DesnetProfile = lazy(() =>
  import("./pages/desnet/Profile").then((m) => ({ default: m.Profile })),
);
const DesnetFeed = lazy(() =>
  import("./pages/desnet/Feed").then((m) => ({ default: m.Feed })),
);
const DesnetAbout = lazy(() =>
  import("./pages/desnet/About").then((m) => ({ default: m.About })),
);
const DesnetOpinion = lazy(() =>
  import("./pages/desnet/Opinion").then((m) => ({ default: m.Opinion })),
);

const DShell = lazy(() => import("./pages/D").then((m) => ({ default: m.DShell })));
const DOverview = lazy(() =>
  import("./pages/d/Overview").then((m) => ({ default: m.DOverview })),
);
const DTrove = lazy(() => import("./pages/d/Trove").then((m) => ({ default: m.DTrove })));
const DSp = lazy(() => import("./pages/d/Sp").then((m) => ({ default: m.DSp })));
const DDonate = lazy(() => import("./pages/d/Donate").then((m) => ({ default: m.DDonate })));
const DRedeem = lazy(() => import("./pages/d/Redeem").then((m) => ({ default: m.DRedeem })));
const DLiquidate = lazy(() =>
  import("./pages/d/Liquidate").then((m) => ({ default: m.DLiquidate })),
);
const DAbout = lazy(() =>
  import("./pages/d/About").then((m) => ({ default: m.DAbout })),
);

const AboutPage = lazy(() => import("./pages/About").then((m) => ({ default: m.AboutPage })));

function PageFallback() {
  return <div className="page-loading">Loading…</div>;
}

function wrap(element: React.ReactElement) {
  return <Suspense fallback={<PageFallback />}>{element}</Suspense>;
}

export function App() {
  return (
    <WalletProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={wrap(<TradePage />)} />
            <Route path="arbitrage" element={wrap(<ArbitragePage />)} />

            <Route path="liquidity" element={wrap(<Liquidity />)}>
              <Route index element={<Navigate to="pools" replace />} />
              <Route path="pools" element={wrap(<PoolsBody />)} />
              <Route path="portfolio" element={wrap(<PortfolioBody />)} />
            </Route>

            <Route path="earn" element={wrap(<Earn />)}>
              <Route index element={<Navigate to="vault" replace />} />
              <Route path="vault" element={wrap(<VaultBody />)} />
              <Route path="staking" element={wrap(<StakingBody />)} />
            </Route>

            <Route path="tools" element={wrap(<Tools />)}>
              <Route index element={<Navigate to="factory" replace />} />
              <Route path="factory" element={wrap(<FactoryBody />)} />
              <Route path="disperse" element={wrap(<DisperseBody />)} />
            </Route>

            <Route path="desnet" element={wrap(<DesnetShell />)}>
              <Route index element={<Navigate to="register" replace />} />
              <Route path="register" element={wrap(<DesnetRegister />)} />
              <Route path="swap" element={wrap(<DesnetSwap />)} />
              <Route path="liquidity" element={wrap(<DesnetLiquidity />)} />
              <Route path="portfolio" element={wrap(<DesnetPortfolio />)} />
            </Route>

            <Route path="desnet/p/:handle" element={wrap(<DesnetProfileShell />)}>
              <Route index element={wrap(<DesnetProfile />)} />
              <Route path="post" element={wrap(<DesnetFeed />)} />
              <Route path="about" element={wrap(<DesnetAbout />)} />
            </Route>

            <Route path="desnet/opinion/:author/:seq" element={wrap(<DesnetOpinion />)} />

            <Route path="d" element={wrap(<DShell />)}>
              <Route index element={wrap(<DOverview />)} />
              <Route path="trove" element={wrap(<DTrove />)} />
              <Route path="sp" element={wrap(<DSp />)} />
              <Route path="donate" element={wrap(<DDonate />)} />
              <Route path="redeem" element={wrap(<DRedeem />)} />
              <Route path="liquidate" element={wrap(<DLiquidate />)} />
              <Route path="about" element={wrap(<DAbout />)} />
            </Route>

            <Route path="about" element={wrap(<AboutPage />)} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WalletProvider>
  );
}
