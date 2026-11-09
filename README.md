# oreno-mcp

MCP server for [Oreno](https://useoreno.com): tokenized-stock market data, screeners, backtests and AI strategy plans on Robinhood Chain.

Free tools need nothing. Paid tools use [x402](https://www.x402.org), so the server pays per call in USDG from a wallet you give it. You don't need an account or an API key.

It runs over stdio, so it works with any MCP client: Hermes Agent, Claude Code, Claude Desktop, Cursor, Codex, OpenClaw, LangChain/LangGraph MCP adapters, CrewAI, the OpenAI Agents SDK and others.

## Tools

| Tool | Cost | What it does |
| --- | --- | --- |
| `oreno_markets` | Free | Every stock token with live price, 24h and 30d change. Filter by symbols or search |
| `oreno_market` | Free | One token: price history, strategies holding it, news |
| `oreno_public_strategies` | Free | Public strategies with rules, backtest and paper results |
| `oreno_public_strategy` | Free | One public strategy in full |
| `oreno_pricing` | Free | Live prices of the paid endpoints |
| `oreno_wallet` | Free | Paying address, caps, and what this session has spent |
| `oreno_screener` | $0.02 | Rank and filter all tokens by returns, volatility, RSI, trend, beta |
| `oreno_token_deep_dive` | $0.03 | History, correlations, Uniswap liquidity, news for one token |
| `oreno_backtest` | $0.05 | Backtest a basket with DCA, rebalancing or a trend filter |
| `oreno_plan_strategy` | $0.25 | Turn a goal in plain words into a checked, backtested strategy |
| `oreno_top_strategies` | $0.02 | Public strategies ranked by paper or backtested return |

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `ORENO_AGENT_KEY` | none | Private key of a wallet holding USDG on Robinhood Chain. Without it, the paid tools return their price and do nothing |
| `ORENO_MAX_USD_PER_CALL` | `0.25` | Refuses to sign any single payment above this |
| `ORENO_BUDGET_USD` | `1` | Total the server may spend before it restarts |
| `ORENO_BASE_URL` | `https://useoreno.com` | API origin |

Use a dedicated wallet holding only a few dollars of USDG. The facilitator pays gas, so the wallet doesn't need ETH.

Safety rules built into the server:
- It only pays Oreno's address `0xF82C00AaD1702de0223cCAFDa7Bf17d5446Cd93e` on `eip155:4663`. It refuses any other payee or network.
- Backtest definitions are checked against Oreno's policy limits before anything is signed.
- A call is only charged when it returns a result. Every settled payment is listed publicly at https://useoreno.com/x402.

## Hermes Agent

In `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  oreno:
    command: "npx"
    args: ["-y", "oreno-mcp"]
    env:
      ORENO_AGENT_KEY: "0x..."
      ORENO_BUDGET_USD: "1"
```

## Claude Code

```bash
claude mcp add oreno -e ORENO_AGENT_KEY=0x... -- npx -y oreno-mcp
```

## Claude Desktop, Cursor and other JSON configs

```json
{
  "mcpServers": {
    "oreno": {
      "command": "npx",
      "args": ["-y", "oreno-mcp"],
      "env": { "ORENO_AGENT_KEY": "0x..." }
    }
  }
}
```

Leave out `ORENO_AGENT_KEY` to use only the free tools.

## From source

```bash
npm install && npm run build
node dist/index.js
```

Everything here is research and market data, not investment advice. Backtests are hypothetical, and Oreno never trades for the caller.
