/**
 * Local (RPC based) replacement for Uniswap's `PortfolioBalancesWeb` GraphQL
 * endpoint.
 *
 * Balances are read directly from each chain's RPC using Multicall3 (one
 * request per chain, falling back to individual calls if Multicall3 is not
 * available), and prices / 24h changes / logos come from CoinGecko.
 *
 * The result keeps the same shape as the old Uniswap portfolio so callers
 * don't need to change.
 */
import { ethers, formatUnits } from "ethers";
import type { Networks, Prices, UniSwapPortfolioResponse } from "@/extension/types";
import { mainNets, testNets } from "@/utils/networks";
import { getNetworks, getPrices } from "@/utils/platform";

type Portfolio = UniSwapPortfolioResponse["data"]["portfolios"][0];
export type PortfolioTokenBalance = Portfolio["tokenBalances"][number];
export type RpcPortfolio = Pick<
  Portfolio,
  | "tokenBalances"
  | "tokensTotalDenominatedValue"
  | "tokensTotalDenominatedValueChange"
>;

type TokenConfig = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** CoinGecko coin id. */
  priceId: string;
};

type ChainConfig = {
  chainId: number;
  /** Label shown in the UI (same values Uniswap used to return). */
  label: string;
  /** Default RPC, overridden by the user's configured network RPC if any. */
  rpc: string;
  native: Omit<TokenConfig, "address">;
  tokens: TokenConfig[];
  multicall?: string;
};

/** Hide balances worth less than this (USD), like Uniswap's `includeSmallBalances: false`. */
const SMALL_BALANCE_THRESHOLD_USD = 1;
const CHAIN_TIMEOUT_MS = 12_000;
const MARKET_CACHE_TTL_MS = 60_000;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const COINGECKO_MARKETS = "https://api.coingecko.com/api/v3/coins/markets";

const t = (
  address: string,
  symbol: string,
  name: string,
  decimals: number,
  priceId: string,
): TokenConfig => ({ address, symbol, name, decimals, priceId });

const ETH_NATIVE = { symbol: "ETH", name: "Ethereum", decimals: 18, priceId: "ethereum" };

export const PORTFOLIO_CHAINS: ChainConfig[] = [
  {
    chainId: 1,
    label: "ETHEREUM",
    rpc: mainNets[1].rpc,
    native: ETH_NATIVE,
    tokens: [
      t("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", "USD Coin", 6, "usd-coin"),
      t("0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT", "Tether USD", 6, "tether"),
      t("0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI", "Dai Stablecoin", 18, "dai"),
      t("0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", "USDe", "Ethena USDe", 18, "ethena-usde"),
      t("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "WETH", "Wrapped Ether", 18, "weth"),
      t("0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", "stETH", "Lido Staked Ether", 18, "staked-ether"),
      t("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "wstETH", "Wrapped stETH", 18, "wrapped-steth"),
      t("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "WBTC", "Wrapped BTC", 8, "wrapped-bitcoin"),
      t("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", "cbBTC", "Coinbase Wrapped BTC", 8, "coinbase-wrapped-btc"),
      t("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "UNI", "Uniswap", 18, "uniswap"),
      t("0x514910771AF9Ca656af840dff83E8264EcF986CA", "LINK", "Chainlink", 18, "chainlink"),
      t("0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", "AAVE", "Aave", 18, "aave"),
      t("0x6982508145454Ce325dDbE47a25d4ec3d2311933", "PEPE", "Pepe", 18, "pepe"),
      t("0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", "SHIB", "Shiba Inu", 18, "shiba-inu"),
    ],
  },
  {
    chainId: 10,
    label: "OPTIMISM",
    rpc: mainNets[10].rpc,
    native: ETH_NATIVE,
    tokens: [
      t("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "USDC", "USD Coin", 6, "usd-coin"),
      t("0x7F5c764cBc14f9669B88837ca1490cCa17c31607", "USDC.e", "Bridged USDC", 6, "usd-coin"),
      t("0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", "USDT", "Tether USD", 6, "tether"),
      t("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", "DAI", "Dai Stablecoin", 18, "dai"),
      t("0x4200000000000000000000000000000000000006", "WETH", "Wrapped Ether", 18, "weth"),
      t("0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb", "wstETH", "Wrapped stETH", 18, "wrapped-steth"),
      t("0x68f180fcCe6836688e9084f035309E29Bf0A2095", "WBTC", "Wrapped BTC", 8, "wrapped-bitcoin"),
      t("0x4200000000000000000000000000000000000042", "OP", "Optimism", 18, "optimism"),
    ],
  },
  {
    chainId: 56,
    label: "BNB",
    rpc: mainNets[56].rpc,
    native: { symbol: "BNB", name: "BNB", decimals: 18, priceId: "binancecoin" },
    tokens: [
      t("0x55d398326f99059fF775485246999027B3197955", "USDT", "Tether USD", 18, "tether"),
      t("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "USDC", "USD Coin", 18, "usd-coin"),
      t("0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", "BUSD", "Binance USD", 18, "binance-usd"),
      t("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "WBNB", "Wrapped BNB", 18, "wbnb"),
      t("0x2170Ed0880ac9A755fd29B2688956BD959F933F8", "ETH", "Binance-Peg Ethereum", 18, "ethereum"),
      t("0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", "BTCB", "Binance-Peg BTC", 18, "bitcoin"),
      t("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", "CAKE", "PancakeSwap", 18, "pancakeswap-token"),
    ],
  },
  {
    chainId: 137,
    label: "POLYGON",
    rpc: mainNets[137].rpc,
    native: { symbol: "POL", name: "Polygon", decimals: 18, priceId: "polygon-ecosystem-token" },
    tokens: [
      t("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USDC", "USD Coin", 6, "usd-coin"),
      t("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "USDC.e", "Bridged USDC", 6, "usd-coin"),
      t("0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "USDT", "Tether USD", 6, "tether"),
      t("0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", "DAI", "Dai Stablecoin", 18, "dai"),
      t("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "WETH", "Wrapped Ether", 18, "weth"),
      t("0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", "WBTC", "Wrapped BTC", 8, "wrapped-bitcoin"),
      t("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "WPOL", "Wrapped POL", 18, "polygon-ecosystem-token"),
      t("0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", "LINK", "Chainlink", 18, "chainlink"),
    ],
  },
  {
    chainId: 324,
    label: "ZKSYNC",
    rpc: "https://mainnet.era.zksync.io",
    multicall: "0xF9cda624FBC7e059355ce98a31693d299FACd963",
    native: ETH_NATIVE,
    tokens: [
      t("0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", "USDC", "USD Coin", 6, "usd-coin"),
      t("0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4", "USDC.e", "Bridged USDC", 6, "usd-coin"),
      t("0x493257fD37EDB34451f62EDf8D2a0C418852bA4C", "USDT", "Tether USD", 6, "tether"),
      t("0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", "WETH", "Wrapped Ether", 18, "weth"),
      t("0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E", "ZK", "ZKsync", 18, "zksync"),
    ],
  },
  {
    chainId: 8453,
    label: "BASE",
    rpc: mainNets[8453].rpc,
    native: ETH_NATIVE,
    tokens: [
      t("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC", "USD Coin", 6, "usd-coin"),
      t("0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", "USDbC", "USD Base Coin", 6, "usd-coin"),
      t("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", "USDT", "Tether USD", 6, "tether"),
      t("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", "DAI", "Dai Stablecoin", 18, "dai"),
      t("0x4200000000000000000000000000000000000006", "WETH", "Wrapped Ether", 18, "weth"),
      t("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", "cbETH", "Coinbase Wrapped Staked ETH", 18, "coinbase-wrapped-staked-eth"),
      t("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", "cbBTC", "Coinbase Wrapped BTC", 8, "coinbase-wrapped-btc"),
      t("0x940181a94A35A4569E4529A3CDfB74e38FD98631", "AERO", "Aerodrome", 18, "aerodrome-finance"),
      t("0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", "DEGEN", "Degen", 18, "degen-base"),
    ],
  },
  {
    chainId: 42161,
    label: "ARBITRUM",
    rpc: mainNets[42161].rpc,
    native: ETH_NATIVE,
    tokens: [
      t("0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USDC", "USD Coin", 6, "usd-coin"),
      t("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", "USDC.e", "Bridged USDC", 6, "usd-coin"),
      t("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "USDT", "Tether USD", 6, "tether"),
      t("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", "DAI", "Dai Stablecoin", 18, "dai"),
      t("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "WETH", "Wrapped Ether", 18, "weth"),
      t("0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", "WBTC", "Wrapped BTC", 8, "wrapped-bitcoin"),
      t("0x912CE59144191C1204E64559FE8253a0e49E6548", "ARB", "Arbitrum", 18, "arbitrum"),
      t("0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", "LINK", "Chainlink", 18, "chainlink"),
      t("0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", "GMX", "GMX", 18, "gmx"),
    ],
  },
  {
    chainId: 42220,
    label: "CELO",
    rpc: mainNets[42220].rpc,
    native: { symbol: "CELO", name: "Celo", decimals: 18, priceId: "celo" },
    tokens: [
      t("0xcebA9300f2b948710d2653dD7B07f33A8B32118C", "USDC", "USD Coin", 6, "usd-coin"),
      t("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", "USDT", "Tether USD", 6, "tether"),
      t("0x765DE816845861e75A25fCA122bb6898B8B1282a", "cUSD", "Celo Dollar", 18, "celo-dollar"),
    ],
  },
  {
    chainId: 43114,
    label: "AVALANCHE",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    native: { symbol: "AVAX", name: "Avalanche", decimals: 18, priceId: "avalanche-2" },
    tokens: [
      t("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "USDC", "USD Coin", 6, "usd-coin"),
      t("0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", "USDT", "Tether USD", 6, "tether"),
      t("0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", "WAVAX", "Wrapped AVAX", 18, "wrapped-avax"),
      t("0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", "WETH.e", "Wrapped Ether", 18, "weth"),
      t("0x152b9d0FdC40C096757F570A51E494bd4b943E50", "BTC.b", "Bitcoin", 8, "bitcoin"),
    ],
  },
  {
    chainId: 7777777,
    label: "ZORA",
    rpc: "https://rpc.zora.energy",
    native: ETH_NATIVE,
    tokens: [
      t("0x4200000000000000000000000000000000000006", "WETH", "Wrapped Ether", 18, "weth"),
    ],
  },
  {
    chainId: 143,
    label: "MONAD",
    rpc: mainNets[143].rpc,
    native: { symbol: "MON", name: "Monad", decimals: 18, priceId: "monad" },
    tokens: [],
  },
];

/* --------------------------------- RPC ---------------------------------- */

const multicallIface = new ethers.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);
const erc20Iface = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
]);

/** Rejects if `p` doesn't settle within `ms`. */
export const withTimeout = <T>(p: Promise<T>, ms: number, label = "request"): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => (clearTimeout(id), resolve(v)),
      (e) => (clearTimeout(id), reject(e)),
    );
  });

const decodeUint = (data: string): bigint => {
  if (!data || data === "0x") return 0n;
  try {
    return BigInt(ethers.dataSlice(data, 0, 32));
  } catch {
    return 0n;
  }
};

/**
 * Returns `[nativeBalance, ...tokenBalances]` (null for failed token reads).
 * Uses one Multicall3 `aggregate3` call; falls back to individual calls.
 */
const readChainBalances = async (
  chain: ChainConfig,
  rpc: string,
  owner: string,
): Promise<(bigint | null)[]> => {
  const provider = new ethers.JsonRpcProvider(
    rpc,
    ethers.Network.from(chain.chainId),
    { staticNetwork: true, batchMaxCount: 10, polling: false },
  );
  try {
    const multicall = chain.multicall ?? MULTICALL3;
    const balanceOfData = erc20Iface.encodeFunctionData("balanceOf", [owner]);
    const calls = [
      {
        target: multicall,
        allowFailure: true,
        callData: multicallIface.encodeFunctionData("getEthBalance", [owner]),
      },
      ...chain.tokens.map((tk) => ({
        target: tk.address,
        allowFailure: true,
        callData: balanceOfData,
      })),
    ];

    try {
      const raw = await provider.call({
        to: multicall,
        data: multicallIface.encodeFunctionData("aggregate3", [calls]),
      });
      const [results] = multicallIface.decodeFunctionResult("aggregate3", raw);
      const out = (results as { success: boolean; returnData: string }[]).map(
        (r) => (r.success ? decodeUint(r.returnData) : null),
      );
      // getEthBalance must succeed; otherwise use the fallback path.
      if (out[0] !== null) return out;
    } catch (err) {
      console.warn(`Multicall failed on ${chain.label}, falling back`, err);
    }

    return await Promise.all([
      provider.getBalance(owner),
      ...chain.tokens.map((tk) =>
        provider
          .call({ to: tk.address, data: balanceOfData })
          .then(decodeUint)
          .catch(() => null),
      ),
    ]);
  } finally {
    provider.destroy();
  }
};

/* -------------------------------- Prices -------------------------------- */

type Market = { price: number; change24h: number | null; image: string | null };

let marketCache: { at: number; ids: string; data: Record<string, Market> } | null =
  null;

const fetchMarkets = async (ids: string[]): Promise<Record<string, Market>> => {
  const key = [...ids].sort().join(",");
  if (marketCache && marketCache.ids === key && Date.now() - marketCache.at < MARKET_CACHE_TTL_MS) {
    return marketCache.data;
  }

  const data: Record<string, Market> = {};
  try {
    const url = `${COINGECKO_MARKETS}?vs_currency=usd&ids=${encodeURIComponent(key)}&per_page=250&price_change_percentage=24h`;
    // The abort signal also covers reading the body, not just the headers.
    const res = await fetch(url, { signal: AbortSignal.timeout(CHAIN_TIMEOUT_MS) });
    if (res.ok) {
      const json = (await res.json()) as {
        id: string;
        current_price: number | null;
        price_change_percentage_24h: number | null;
        image: string | null;
      }[];
      for (const m of json) {
        if (typeof m.current_price !== "number") continue;
        data[m.id] = {
          price: m.current_price,
          change24h: m.price_change_percentage_24h ?? null,
          image: m.image ?? null,
        };
      }
      marketCache = { at: Date.now(), ids: key, data };
      return data;
    }
  } catch (err) {
    console.warn("CoinGecko markets request failed", err);
  }

  // Fallback: cached simple prices from the service worker (no change/logo).
  const cached: Prices = await getPrices();
  for (const id of ids) {
    const usd = cached?.[id]?.usd;
    if (typeof usd === "number") data[id] = { price: usd, change24h: null, image: null };
  }
  return data;
};

/* ------------------------------- Portfolio ------------------------------ */

const buildEntry = (
  chain: ChainConfig,
  token: TokenConfig,
  isNative: boolean,
  quantity: number,
  market: Market | undefined,
): PortfolioTokenBalance =>
  ({
    id: `${chain.label}-${token.address}-balance`.toLowerCase(),
    quantity,
    denominatedValue: market ? { value: quantity * market.price } : null,
    token: {
      id: `${chain.label}-${token.address}`.toLowerCase(),
      address: token.address,
      chain: chain.label,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      standard: isNative ? "NATIVE" : "ERC20",
      project: {
        id: token.priceId,
        name: token.name,
        logo: null,
        safetyLevel: "verified",
        logoUrl: market?.image ?? null,
        isSpam: false,
        __typename: "TokenProject",
      },
      __typename: "Token",
    },
    tokenProjectMarket: {
      id: `${token.priceId}-market`,
      pricePercentChange:
        market?.change24h != null ? { value: market.change24h } : null,
      tokenProject: {
        id: token.priceId,
        logoUrl: market?.image ?? null,
        isSpam: false,
        __typename: "TokenProject",
      },
      __typename: "TokenProjectMarket",
    },
    __typename: "TokenBalance",
  }) as unknown as PortfolioTokenBalance;

/** Canton is handled separately by the assets view. */
const EXCLUDED_CHAIN_IDS = new Set([31337, 30337]);

/**
 * Chains to scan = the networks the user has added (what the Networks tab
 * shows), minus Canton and testnets. Known chains use the curated token list;
 * any other network gets its native balance only. The user's RPC is always used.
 */
export const getPortfolioChains = (networks: Networks): ChainConfig[] =>
  Object.values(networks ?? {})
    .filter(
      (n) =>
        n?.rpc &&
        !EXCLUDED_CHAIN_IDS.has(Number(n.chainId)) &&
        !(Number(n.chainId) in testNets),
    )
    .map((n) => {
      const chainId = Number(n.chainId);
      const known = PORTFOLIO_CHAINS.find((c) => c.chainId === chainId);
      if (known) return { ...known, rpc: n.rpc };
      return {
        chainId,
        label: n.name.toUpperCase(),
        rpc: n.rpc,
        native: {
          symbol: n.symbol ?? "ETH",
          name: n.name,
          decimals: 18,
          priceId: n.priceId ?? mainNets[chainId]?.priceId ?? "",
        },
        tokens: [],
      };
    });

/**
 * Builds the portfolio for `owner` across the user's added networks using RPCs.
 * Returns `null` only if every chain failed (e.g. no connectivity).
 */
export const getRpcPortfolio = async (
  owner: string,
  networks?: Networks,
): Promise<RpcPortfolio | null> => {
  const userNetworks =
    networks ?? (((await getNetworks().catch(() => ({}))) ?? {}) as Networks);
  const chains = getPortfolioChains(userNetworks);

  const settled = await Promise.allSettled(
    chains.map((chain) =>
      withTimeout(
        readChainBalances(chain, chain.rpc, owner),
        CHAIN_TIMEOUT_MS,
        chain.label,
      ),
    ),
  );

  // No chains to scan isn't an error, just an empty portfolio.
  if (chains.length > 0 && settled.every((s) => s.status === "rejected")) return null;

  // Collect non-zero holdings.
  const holdings: { chain: ChainConfig; token: TokenConfig; isNative: boolean; quantity: number }[] = [];
  settled.forEach((s, i) => {
    const chain = chains[i];
    if (s.status === "rejected") {
      console.warn(`Failed to read balances on ${chain.label}`, s.reason);
      return;
    }
    const tokens: [TokenConfig, boolean][] = [
      [{ ...chain.native, address: "native" }, true],
      ...chain.tokens.map((tk) => [tk, false] as [TokenConfig, boolean]),
    ];
    s.value.forEach((raw, j) => {
      if (!raw || raw <= 0n) return;
      const [token, isNative] = tokens[j];
      const quantity = Number(formatUnits(raw, token.decimals));
      if (quantity > 0 && Number.isFinite(quantity)) {
        holdings.push({ chain, token, isNative, quantity });
      }
    });
  });

  const markets = holdings.length
    ? await fetchMarkets([...new Set(holdings.map((h) => h.token.priceId).filter(Boolean))])
    : {};

  let total = 0;
  let previousTotal = 0;
  const tokenBalances: PortfolioTokenBalance[] = [];

  for (const h of holdings) {
    const market = markets[h.token.priceId];
    const value = market ? h.quantity * market.price : null;
    // Drop dust (only when we actually know its value).
    if (value !== null && value < SMALL_BALANCE_THRESHOLD_USD) continue;

    tokenBalances.push(buildEntry(h.chain, h.token, h.isNative, h.quantity, market));
    if (value !== null) {
      total += value;
      const change = market?.change24h ?? 0;
      previousTotal += value / (1 + change / 100);
    }
  }

  tokenBalances.sort(
    (a, b) => (b.denominatedValue?.value ?? 0) - (a.denominatedValue?.value ?? 0),
  );

  const absolute = total - previousTotal;
  const percentage = previousTotal > 0 ? (absolute / previousTotal) * 100 : 0;

  return {
    tokenBalances,
    tokensTotalDenominatedValue: { id: "total-value", value: total },
    tokensTotalDenominatedValueChange: {
      absolute: { id: "absolute-change", value: absolute },
      percentage: { id: "percentage-change", value: percentage },
    },
  } as RpcPortfolio;
};
