// Minimal x402 v2 "exact" client for Oreno: call, read the 402, sign a USDG
// EIP-3009 TransferWithAuthorization, retry with PAYMENT-SIGNATURE.
// Payments are pinned to Oreno's payTo and Robinhood Chain, and capped per
// call and per process so an agent cannot spend more than the user allowed.

import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const ORENO_PAY_TO = "0xf82c00aad1702de0223ccafda7bf17d5446cd93e";
export const CHAIN_ID = 4663;

type Requirement = {
  scheme: string;
  network: string;
  amount: string;
  asset: Hex;
  payTo: Hex;
  maxTimeoutSeconds?: number;
  extra: { name: string; version: string };
};

export type PaidResult = {
  status: number;
  data: unknown;
  paidUsd: number;
  settlement?: unknown;
};

export class OrenoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly charged = false,
  ) {
    super(message);
  }
}

const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const dec = (h: string | null): any => {
  if (!h) return null;
  try {
    return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  } catch {
    return null;
  }
};

async function body(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorText(data: unknown): string {
  if (data && typeof data === "object" && "error" in data) {
    const e = (data as { error: unknown }).error;
    return typeof e === "string" ? e : JSON.stringify(e);
  }
  return typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500);
}

export class Payer {
  readonly account?: PrivateKeyAccount;
  spentUsd = 0;
  calls = 0;

  constructor(
    key: string | undefined,
    readonly maxPerCallUsd: number,
    readonly budgetUsd: number,
  ) {
    if (key) {
      const k = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
      this.account = privateKeyToAccount(k);
    }
  }

  get remainingUsd() {
    return Math.max(0, this.budgetUsd - this.spentUsd);
  }

  /** Makes the request, paying once if the endpoint answers 402. */
  async call(url: string, init: { method: "GET" | "POST"; json?: unknown }): Promise<PaidResult> {
    const make = (headers: Record<string, string> = {}): RequestInit =>
      init.method === "POST"
        ? {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(init.json ?? {}),
          }
        : { headers };

    const first = await fetch(url, make());
    if (first.status !== 402) {
      const data = await body(first);
      if (!first.ok) throw new OrenoError(`${first.status}: ${errorText(data)}`, first.status);
      return { status: first.status, data, paidUsd: 0 };
    }

    const required = dec(first.headers.get("payment-required")) ?? (await body(first));
    const req: Requirement | undefined = required?.accepts?.[0];
    if (!req) throw new OrenoError("Got 402 without readable payment requirements", 402);

    const priceUsd = Number(req.amount) / 1e6;
    if (req.payTo.toLowerCase() !== ORENO_PAY_TO)
      throw new OrenoError(`Refusing to pay unexpected address ${req.payTo}`);
    if (req.network !== `eip155:${CHAIN_ID}`)
      throw new OrenoError(`Refusing to pay on unexpected network ${req.network}`);
    if (!(priceUsd > 0)) throw new OrenoError(`Unreadable price ${req.amount}`);
    if (priceUsd > this.maxPerCallUsd)
      throw new OrenoError(
        `Price $${priceUsd} is above ORENO_MAX_USD_PER_CALL ($${this.maxPerCallUsd}). Nothing was signed.`,
      );
    if (priceUsd > this.remainingUsd + 1e-9)
      throw new OrenoError(
        `Price $${priceUsd} would exceed the session budget (ORENO_BUDGET_USD $${this.budgetUsd}, $${this.spentUsd.toFixed(2)} spent). Nothing was signed. Restart the server or raise the budget.`,
      );
    if (!this.account)
      throw new OrenoError(
        `This endpoint costs $${priceUsd} USDG. Set ORENO_AGENT_KEY to a wallet key holding USDG on Robinhood Chain to enable paid tools.`,
      );

    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: this.account.address,
      to: req.payTo,
      value: req.amount,
      validAfter: String(now - 5),
      validBefore: String(now + Math.min(Math.max(req.maxTimeoutSeconds ?? 120, 30), 3600)),
      nonce: keccak256(toHex(crypto.getRandomValues(new Uint8Array(32)))),
    };

    const signature = await this.account.signTypedData({
      domain: {
        name: req.extra.name,
        version: req.extra.version,
        chainId: CHAIN_ID,
        verifyingContract: req.asset,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });

    const payment = {
      x402Version: 2,
      resource: required.resource,
      accepted: req,
      payload: { signature, authorization },
    };
    const res = await fetch(url, make({ "PAYMENT-SIGNATURE": enc(payment) }));
    const settlement = dec(res.headers.get("payment-response")) ?? undefined;
    const data = await body(res);

    if (!res.ok) {
      const refused = dec(res.headers.get("payment-required"));
      throw new OrenoError(`${res.status}: ${refused?.error ?? errorText(data)}`, res.status);
    }

    this.calls += 1;
    this.spentUsd += priceUsd;
    return { status: res.status, data, paidUsd: priceUsd, settlement };
  }
}
