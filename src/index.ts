#!/usr/bin/env node
// Oreno MCP server (stdio). Free tools read Oreno's public API. Paid tools
// call Oreno's x402 endpoints and pay per call in USDG on Robinhood Chain
// from the wallet in ORENO_AGENT_KEY, within per-call and session caps.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OrenoError, Payer } from "./x402.js";

const BASE = (process.env.ORENO_BASE_URL ?? "https://useoreno.com").replace(/\/$/, "");
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

let payer: Payer;
try {
  payer = new Payer(
    process.env.ORENO_AGENT_KEY,
    num(process.env.ORENO_MAX_USD_PER_CALL, 0.25),
    num(process.env.ORENO_BUDGET_USD, 1),
  );
} catch {
  console.error("ORENO_AGENT_KEY is not a valid private key. Paid tools are disabled.");
  payer = new Payer(undefined, 0.25, 1);
}

const DISCLAIMER =
  "Research and market data only, not investment advice. Backtests are hypothetical. Oreno never trades for the caller.";

const server = new McpServer(
  { name: "oreno", version: "0.1.0" },
  {
    instructions:
      "Oreno: tokenized-stock research on Robinhood Chain. Free tools (oreno_markets, oreno_market, " +
      "oreno_public_strategies, oreno_public_strategy, oreno_pricing, oreno_wallet) cost nothing. Paid tools " +
      "say their price in the description and pay in USDG from the configured wallet. Tell the user the price " +
      "before the first paid call unless they already agreed. Use oreno_markets to check symbols before paid " +
      "calls. Keep the disclaimer with results you show: " +
      DISCLAIMER,
  },
);

type Out = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): Out => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string): Out => ({ content: [{ type: "text", text: msg }], isError: true });

async function run(fn: () => Promise<unknown>): Promise<Out> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof OrenoError) {
      const free = (err.status === 400 || err.status === 404) && !/not (charged|paid|signed)/i.test(err.message);
      return fail(err.message.replace(/([^.])$/, "$1.") + (free ? " You were not charged." : ""));
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}

async function getFree(path: string): Promise<any> {
  const res = await fetch(BASE + path, { headers: { accept: "application/json" } });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new OrenoError(`${res.status}: ${data?.error ?? text.slice(0, 300)}`, res.status);
  return data;
}

async function paid(method: "GET" | "POST", path: string, json?: unknown) {
  const r = await payer.call(BASE + path, { method, json });
  return {
    result: r.data,
    payment: r.paidUsd
      ? {
          paidUsd: r.paidUsd,
          settlement: r.settlement,
          sessionSpentUsd: Number(payer.spentUsd.toFixed(6)),
          sessionRemainingUsd: Number(payer.remainingUsd.toFixed(6)),
        }
      : { paidUsd: 0 },
  };
}

const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const SYMBOL = z
  .string()
  .regex(/^[A-Za-z]{1,6}$/, "1 to 6 letters")
  .transform((s) => s.toUpperCase());

// ---------- free tools ----------

server.registerTool(
  "oreno_markets",
  {
    title: "List stock tokens (free)",
    description:
      "Free. Every priced tokenized stock/ETF on Robinhood Chain with live Chainlink price, 24h and 30d change. " +
      "Use to look up valid symbols before other calls. Filter by symbols or a name/ticker search.",
    inputSchema: {
      symbols: z.array(z.string()).max(100).optional().describe("Only these tickers, e.g. ['NVDA','AAPL']"),
      search: z.string().max(60).optional().describe("Case-insensitive match on ticker or name"),
      sort: z.enum(["symbol", "change24h", "change30d"]).optional().describe("Default symbol"),
      limit: z.number().int().min(1).max(300).optional().describe("Default all"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ symbols, search, sort, limit }) =>
    run(async () => {
      const data = await getFree("/api/public/markets");
      const want = symbols?.length ? new Set(symbols.map((s) => s.toUpperCase())) : null;
      const q = search?.toLowerCase();
      let rows = (data.markets as any[])
        .filter((m) => !want || want.has(m.symbol))
        .filter((m) => !q || m.symbol.toLowerCase().includes(q) || String(m.name).toLowerCase().includes(q))
        .map((m) => ({
          symbol: m.symbol,
          name: m.name,
          priceUsd: Number(m.price),
          change24hPct: m.change24h,
          change30dPct: m.change30d === undefined ? null : Number(Number(m.change30d).toFixed(2)),
          token: m.token,
          oraclePaused: m.oraclePaused,
        }));
      const key = sort ?? "symbol";
      rows.sort((a: any, b: any) =>
        key === "symbol" ? a.symbol.localeCompare(b.symbol) : (b[key + "Pct"] ?? -1e9) - (a[key + "Pct"] ?? -1e9),
      );
      if (limit) rows = rows.slice(0, limit);
      return { generatedAt: data.generatedAt, latestClose: data.latestClose, count: rows.length, markets: rows };
    }),
);

server.registerTool(
  "oreno_market",
  {
    title: "One stock token (free)",
    description:
      "Free. One Robinhood Chain stock token: live price, daily on-chain price history, public strategies holding it, and news.",
    inputSchema: {
      symbol: SYMBOL.describe("Ticker, e.g. NVDA"),
      days: z.number().int().min(1).max(1000).optional().describe("Days of history to return (default 90)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ symbol, days }) =>
    run(async () => {
      const d = await getFree(`/api/public/markets/${symbol}`);
      const { spark, ...market } = d.market ?? {};
      return { ...d, market, history: Array.isArray(d.history) ? d.history.slice(-(days ?? 90)) : d.history };
    }),
);

server.registerTool(
  "oreno_public_strategies",
  {
    title: "Public strategies (free)",
    description:
      "Free. Every public Oreno strategy with its rules, backtest metrics and forward (paper) results, kept separate.",
    inputSchema: {
      kind: z.string().max(40).optional().describe("Filter by kind, e.g. threshold_rebalance"),
      symbol: z.string().max(6).optional().describe("Only strategies holding this ticker"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ kind, symbol }) =>
    run(async () => {
      const d = await getFree("/api/public/strategies");
      const sym = symbol?.toUpperCase();
      const list = (d.strategies as any[])
        .filter((s) => !kind || s.kind === kind)
        .filter((s) => !sym || s.definition?.allocations?.some((a: any) => a.symbol === sym))
        .map(({ backtest, ...s }) => ({
          ...s,
          backtest: backtest ? { metrics: backtest.metrics } : null,
        }));
      return { count: list.length, strategies: list };
    }),
);

server.registerTool(
  "oreno_public_strategy",
  {
    title: "One public strategy (free)",
    description: "Free. Full detail for one public strategy by id, including backtest series and paper results.",
    inputSchema: { id: z.string().min(1).max(120).describe("Strategy id from oreno_public_strategies") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ id }) => run(() => getFree(`/api/public/strategies/${encodeURIComponent(id)}`)),
);

server.registerTool(
  "oreno_pricing",
  {
    title: "Paid endpoint prices (free)",
    description: "Free. Lists Oreno's paid x402 endpoints with live prices and input schemas, and whether the API is open.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  () =>
    run(async () => {
      const d = await getFree("/api/x402");
      return {
        open: d.open,
        network: d.network,
        endpoints: (d.endpoints as any[]).map((e) => ({
          url: e.url,
          method: e.method,
          priceUsd: e.priceUsd,
          description: e.description,
        })),
        receipts: `${BASE}/x402`,
      };
    }),
);

server.registerTool(
  "oreno_wallet",
  {
    title: "Payment wallet status (free)",
    description:
      "Free. Shows whether paid tools are enabled, the paying wallet address, the per-call cap, and what this session has spent.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () =>
    ok({
      paidToolsEnabled: Boolean(payer.account),
      address: payer.account?.address ?? null,
      asset: "USDG on Robinhood Chain (eip155:4663)",
      maxPerCallUsd: payer.maxPerCallUsd,
      sessionBudgetUsd: payer.budgetUsd,
      sessionSpentUsd: Number(payer.spentUsd.toFixed(6)),
      sessionRemainingUsd: Number(payer.remainingUsd.toFixed(6)),
      paidCalls: payer.calls,
      hint: payer.account ? undefined : "Set ORENO_AGENT_KEY to a wallet key with USDG on Robinhood Chain.",
    }),
);

// ---------- paid tools ----------

const PAID = { readOnlyHint: true, openWorldHint: true, idempotentHint: false } as const;

server.registerTool(
  "oreno_screener",
  {
    title: "Market screener ($0.02)",
    description:
      "PAID $0.02 USDG. Screens every Robinhood Chain stock token: live price, 7/30/90-day and YTD returns, 30d volatility, " +
      "drawdown from high, SMA trend, RSI(14) and beta vs SPY. Sort and filter in one call.",
    inputSchema: {
      symbols: z.array(SYMBOL).max(60).optional().describe("Only these tickers"),
      sort: z
        .enum(["symbol", "change24h", "return7d", "return30d", "return90d", "volatility30d", "fromHigh", "rsi14", "beta"])
        .optional()
        .describe("Default return30d"),
      order: z.enum(["desc", "asc"]).optional(),
      trend: z.enum(["up", "down", "mixed"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: PAID,
  },
  ({ symbols, ...rest }) =>
    run(() => paid("GET", `/api/x402/markets${qs({ ...rest, symbols: symbols?.join(",") })}`)),
);

server.registerTool(
  "oreno_token_deep_dive",
  {
    title: "Token deep dive ($0.03)",
    description:
      "PAID $0.03 USDG. One stock token in depth: price history, full stats, correlations, live Uniswap liquidity and " +
      "price impact vs Chainlink, strategies holding it, and news.",
    inputSchema: {
      symbol: SYMBOL.describe("Ticker, e.g. NVDA"),
      days: z.number().int().min(5).max(1000).optional().describe("History window, default 365"),
    },
    annotations: PAID,
  },
  (args) => run(() => paid("GET", `/api/x402/markets/detail${qs(args)}`)),
);

const Allocation = z.object({
  symbol: SYMBOL,
  weightBps: z.number().int().min(1).max(10000),
});
const Definition = z.object({
  allocations: z.array(Allocation).min(1).max(20).describe("Weights must total exactly 10000 bps"),
  initialUsd: z.number().int().min(0).max(1_000_000),
  dca: z
    .object({ amountUsd: z.number().min(1), interval: z.enum(["weekly", "monthly"]) })
    .nullable()
    .optional(),
  rebalance: z
    .object({ interval: z.enum(["weekly", "monthly", "quarterly"]), bandBps: z.number().int().min(0).max(10000) })
    .nullable()
    .optional(),
  maxPositionBps: z.number().int().min(100).max(10000),
  trend: z
    .object({
      symbol: SYMBOL,
      lookbackDays: z.number().int().min(5).max(60),
      ifBelow: z.array(Allocation).max(20).describe("Held when below the SMA; empty = cash"),
    })
    .nullable()
    .optional(),
});

function policyProblems(d: z.infer<typeof Definition>): string[] {
  const out: string[] = [];
  const total = (xs: { weightBps: number }[]) => xs.reduce((s, a) => s + a.weightBps, 0);
  if (total(d.allocations) !== 10000) out.push(`allocations total ${total(d.allocations)} bps, must be 10000`);
  const syms = d.allocations.map((a) => a.symbol);
  if (new Set(syms).size !== syms.length) out.push("duplicate symbols in allocations");
  const cap = Math.min(2500, d.maxPositionBps);
  for (const a of [...d.allocations, ...(d.trend?.ifBelow ?? [])])
    if (a.weightBps > cap) out.push(`${a.symbol} at ${a.weightBps} bps is above the ${cap} bps position cap`);
  if (d.trend?.ifBelow?.length && total(d.trend.ifBelow) !== 10000) out.push("trend.ifBelow must total 10000 or be empty");
  if (d.trend && !d.rebalance) out.push("a trend filter needs a rebalance schedule");
  if (d.initialUsd > 10000) out.push("initialUsd is above the $10,000 policy limit");
  if (d.dca) {
    const monthly = d.dca.interval === "weekly" ? (d.dca.amountUsd * 52) / 12 : d.dca.amountUsd;
    if (monthly > 1000) out.push("recurring deposits are above $1,000 a month");
  }
  return out;
}

server.registerTool(
  "oreno_backtest",
  {
    title: "Backtest a basket ($0.05)",
    description:
      "PAID $0.05 USDG. Backtests a tokenized-stock portfolio on Robinhood Chain prices (about five years incl. off-chain " +
      "closes): buy and hold, DCA, scheduled or drift-band rebalancing, optional SMA trend filter. Returns metrics, equity " +
      "curve and SPY benchmark. Policy: weights total 10000 bps, max 2500 bps per position (so at least 4 names), " +
      "initialUsd <= 10000, deposits <= $1000/month. Policy violations are checked before paying.",
    inputSchema: { definition: Definition },
    annotations: PAID,
  },
  ({ definition }) =>
    run(async () => {
      const problems = policyProblems(definition);
      if (problems.length)
        throw new OrenoError(`Definition fails Oreno policy: ${problems.join("; ")}. Nothing was signed or charged.`, 400);
      const def = { dca: null, rebalance: null, ...definition };
      const r = await paid("POST", "/api/x402/backtest", { definition: def });
      if (r.result && typeof r.result === "object" && "series" in r.result) {
        const series = (r.result as any).series;
        if (Array.isArray(series) && series.length > 60) {
          const step = Math.ceil(series.length / 60);
          (r.result as any).series = series.filter((_: unknown, i: number) => i % step === 0 || i === series.length - 1);
        }
      }
      return r;
    }),
);

server.registerTool(
  "oreno_plan_strategy",
  {
    title: "AI strategy planner ($0.25)",
    description:
      "PAID $0.25 USDG. The Oreno Agent turns an investing goal in plain words into a policy-checked, backtested " +
      "tokenized-stock strategy. Use when the user has a goal but no basket.",
    inputSchema: {
      goal: z.string().min(10).max(2000).describe("e.g. 'Steady AI exposure, $1,000 plus $100 a month, low drawdown'"),
    },
    annotations: PAID,
  },
  ({ goal }) => run(() => paid("POST", "/api/x402/plan", { goal })),
);

server.registerTool(
  "oreno_top_strategies",
  {
    title: "Top public strategies ($0.02)",
    description:
      "PAID $0.02 USDG. Public strategies ranked by forward (paper) or backtested return, with full rules. " +
      "For an unranked list use the free oreno_public_strategies.",
    inputSchema: {
      sort: z.enum(["forward", "backtest"]).optional().describe("Default forward"),
      kind: z.string().max(40).optional(),
      limit: z.number().int().min(1).max(20).optional().describe("Default 10"),
    },
    annotations: PAID,
  },
  (args) => run(() => paid("GET", `/api/x402/strategies/top${qs(args)}`)),
);

await server.connect(new StdioServerTransport());
console.error(
  `oreno-mcp ready (${BASE}). Paid tools ${payer.account ? `enabled for ${payer.account.address}` : "disabled: set ORENO_AGENT_KEY"}.`,
);
