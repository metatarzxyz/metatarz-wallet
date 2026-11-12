<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>Assets</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <ion-loading
        :is-open="loading"
        cssClass="my-custom-class"
        message="Please wait..."
        :key="`k${loading}`"
        @didDismiss="loading = false"
      >
      </ion-loading>
      <ion-toast
        position="top"
        :is-open="toastState"
        @didDismiss="toastState = false"
        message="Copied to clipboard"
        :duration="1500"
      ></ion-toast>
      <template v-if="!noSelectedAccount">
        <ion-item>
          <ion-label style="text-align: center"
            >Assets for: {{ selectedAccount?.name }}</ion-label
          >
        </ion-item>
        <ion-item
          button
          @click="copyText(selectedAccount?.address, getToastRef())"
        >
          <p style="font-size: 0.7rem">{{ selectedAccount?.address }}</p>
          <ion-icon style="margin-left: 0.5rem" :icon="copyOutline"></ion-icon>
        </ion-item>
        <ion-item
          v-if="selectedAccount?.cantonParty"
          button
          @click="copyText(selectedAccount?.cantonParty || '', getToastRef())"
        >
          <p style="font-size: 0.7rem">{{ selectedAccount?.cantonParty }}</p>
          <ion-icon style="margin-left: 0.5rem" :icon="copyOutline"></ion-icon>
        </ion-item>
        <ion-item v-if="assetsValue?.value">
          <ion-list style="width: 100%; display: grid; justify-content: center">
            <ion-item
              ><b>Total Value:&nbsp;</b>
              <span style="color: #ffcc00; font-size: 0.9rem">
                {{ formatNumber(assetsValue?.value, 2) }} $</span
              ></ion-item
            >
            <ion-item
              ><b>24H Change:&nbsp;</b>
              <arrow-up v-if="assetsChange.percentage.value > 0" />
              <arrow-down v-else />
              <span
                :style="`font-size: 0.9rem;color: ${
                  assetsChange.percentage.value > 0 ? '#33cc33' : '#ff5050'
                }`"
              >
                {{ formatNumber(assetsChange.percentage.value, 2) }}%</span
              ></ion-item
            >
          </ion-list>
        </ion-item>
      </template>
      <template v-if="noSelectedAccount">
        <p class="warn-msg">
          No account selected, please select an account to see assets.
        </p>
      </template>
      <template v-else-if="isError">
        <p class="warn-msg">
          Assets info could not be retrieved because of an http error, API down
          or conectivity issues.
        </p>
      </template>
      <template v-else-if="noAssets">
        <p class="warn-msg">No know assets found for this wallet address.</p>
      </template>
      <template v-else>
        <ion-list>
          <ion-item>
            <ion-label style="text-align: center">Tokens</ion-label>
          </ion-item>
          <ion-list>
            <ion-item v-for="token of shownTokens" :key="token.token.address">
              <ion-avatar
                style="margin-right: 1rem; width: 1.6rem; height: 1.6rem"
              >
                <img
                  v-if="token?.token?.project?.logoUrl"
                  :alt="token?.token?.name"
                  :src="token?.token?.project?.logoUrl"
                />
                <img
                  v-else-if="getCantonLogo(token)"
                  :alt="token?.token?.name"
                  :src="getUrl(`assets/chain-icons/${getCantonLogo(token)}`)"
                />
                <img
                  v-else
                  :alt="token?.token?.name"
                  :src="getUrl('assets/randomGrad.svg')"
                />
              </ion-avatar>
              <ion-label class="flex-col flex">
                <div class="flex">
                  <b>{{ token?.token?.symbol }}:</b>
                  {{ formatNumber(token?.quantity, 9) }}
                </div>
                <div class="flex">
                  <span style="font-size: 0.8rem; opacity: 0.7">{{
                    token?.token?.chain
                  }}</span>
                </div> </ion-label
              ><span style="font-size: 0.8rem; opacity: 0.7"
                >{{ formatNumber(token?.denominatedValue?.value, 2) }} $</span
              >
            </ion-item>
            <ion-item v-if="alltokens.length > shownTokens.length">
              <ion-button
                @click="
                  shownTokens = alltokens.slice(0, shownTokens.length + 10)
                "
                >Load More</ion-button
              >
            </ion-item>
          </ion-list>
        </ion-list>
      </template>
    </ion-content>
  </ion-page>
</template>

<script lang="ts" setup>
import { Ref, ref } from "vue";
import {
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  onIonViewWillEnter,
  IonItem,
  IonLabel,
  IonAvatar,
  IonList,
  IonButton,
  IonToast,
  IonLoading,
  IonIcon,
} from "@ionic/vue";
import {
  getSelectedAccount,
  copyText,
  getUrl,
  openTab,
  getSelectedNetwork,
  getPrices,
  getNetworks,
} from "@/utils/platform";
import type {
  Account,
  Network,
  UniSwapPortfolioResponse,
} from "@/extension/types";
import {
  formatNumber,
  getBalance,
  getCantonBalance,
  getCantonNetworkProvider,
} from "@/utils/wallet";
import ArrowDown from "@/components/icons/ArrowDown.vue";
import ArrowUp from "@/components/icons/ArrowUp.vue";
import { copyOutline } from "ionicons/icons";
import BridgeIcon from "@/components/icons/Bridge.vue";
import { formatEther, formatUnits } from "ethers";
import { chainIdToPriceId } from "@/utils/networks";
import { getRpcPortfolio, withTimeout } from "@/utils/portfolio";

type TokenBalance =
  UniSwapPortfolioResponse["data"]["portfolios"][0]["tokenBalances"][number];

type CantonAssetConfig = {
  /** Contract address (or "native" for the chain's native coin). */
  address: string;
  /** Display symbol. */
  symbol: string;
  /** Display name. */
  name: string;
  /** Token decimals used for formatting the raw balance. */
  decimals: number;
  /** Key into the `prices` object returned by `getPrices()`. */
  priceKey: string;
  /** Optional fixed USD price (e.g. stablecoins). Takes precedence. */
  fixedPrice?: number;
  /** Optional local logo file under `assets/chain-icons/`. */
  logoFile?: string;
  /** Optional custom balance reader. Defaults to `balanceOf`. */
  readBalance?: (provider: any, owner: string) => Promise<bigint>;
};

const NATIVE_CANTON: CantonAssetConfig = {
  address: "native",
  symbol: "CC",
  name: "Canton Network",
  decimals: 9,
  priceKey: "canton",
  logoFile: "canton.webp",
};

const CANTON_ASSETS: CantonAssetConfig[] = [
  {
    address: "0xDE40000000000000000000000000000000000001",
    symbol: "USDCx",
    name: "Canton USDC",
    decimals: 6,
    priceKey: "usd-coin",
    fixedPrice: 1,
  },
  {
    address: "0xDE50000000000000000000000000000000000001",
    symbol: "HANDL",
    name: "Handl",
    decimals: 18,
    priceKey: "handl",
  },
  {
    address: "0xDE60000000000000000000000000000000000001",
    symbol: "CBTC",
    name: "Canton wrapped Bitcoin",
    decimals: 18,
    priceKey: "bitcoin",
    logoFile: "canton-cbtc.webp",
  },
  {
    address: "0xDE70000000000000000000000000000000000001",
    symbol: "cETH",
    name: "Canton Ethereum",
    decimals: 18,
    priceKey: "ethereum",
    logoFile: "canton-ceth.webp",
  },
  {
    address: "0xDE80000000000000000000000000000000000001",
    symbol: "BETH",
    name: "BETH",
    decimals: 18,
    priceKey: "ethereum",
    logoFile: "canton-beth.webp",
  },
];

/** Symbol -> local logo filename lookup used by the template. */
const cantonLogoBySymbol: Record<string, string> = Object.fromEntries(
  [NATIVE_CANTON, ...CANTON_ASSETS]
    .filter((a) => a.logoFile)
    .map((a) => [a.symbol, a.logoFile as string]),
);

const getCantonLogo = (token: any): string | null =>
  cantonLogoBySymbol[token?.token?.symbol] ?? null;

const selectedAccount = ref({}) as Ref<Account>;
const loading = ref(true);
const isError = ref(false);
const noSelectedAccount = ref(false);
const noAssets = ref(false);
const toastState = ref(false);
const getToastRef = () => toastState;
const isCanton = ref(false);
const selectedNetwork = ref(null) as unknown as Ref<Network>;

const alltokens = ref([]) as Ref<TokenBalance[]>;
const shownTokens = ref([]) as Ref<TokenBalance[]>;

const assetsValue = ref({}) as Ref<
  UniSwapPortfolioResponse["data"]["portfolios"][0]["tokensTotalDenominatedValue"]
>;

const assetsChange = ref({}) as Ref<
  UniSwapPortfolioResponse["data"]["portfolios"][0]["tokensTotalDenominatedValueChange"]
>;

/** Default `balanceOf(owner)` reader via `eth_call`. */
const readErc20Balance = async (
  provider: any,
  tokenAddress: string,
  owner: string,
): Promise<bigint> => {
  const addr = owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const data = `0x70a08231${addr}`;
  const res = await provider.send("eth_call", [
    { to: tokenAddress, data },
    "latest",
  ]);
  if (!res || res === "0x" || res === "0x0") return 0n;
  return BigInt(res);
};

/** Normalize a raw bigint balance to a human number rounded to 9 decimals. */
const toDisplayQuantity = (raw: bigint, decimals: number): number => {
  const asNumber = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(asNumber)) return 0;
  return Math.round(asNumber * 1e9) / 1e9;
};

/** Build a Uniswap-shaped `TokenBalance` entry from a Canton config. */
const buildCantonTokenEntry = (
  cfg: CantonAssetConfig,
  quantity: number,
  priceUsd: number,
  chainLabel: string,
): TokenBalance =>
  ({
    id: `canton-${cfg.symbol.toLowerCase()}-balance`,
    quantity,
    denominatedValue: { value: +(quantity * priceUsd).toFixed(2) },
    token: {
      id: `canton-${cfg.symbol.toLowerCase()}-native`,
      address: "native",
      chain: chainLabel,
      symbol: cfg.symbol,
      name: cfg.name,
      decimals: cfg.decimals,
      standard: "NATIVE",
      project: {
        id: cfg.priceKey,
        name: cfg.name,
        logo: null,
        safetyLevel: "verified",
        logoUrl: null,
        isSpam: false,
        __typename: "Project",
      },
      __typename: "Token",
    },
    tokenProjectMarket: {
      id: "canton-market",
      pricePercentChange: null,
      tokenProject: {
        id: "canton",
        logoUrl: null,
        isSpam: false,
        __typename: "TokenProject",
      },
      __typename: "TokenProjectMarket",
    },
    __typename: "TokenBalance",
  }) as unknown as TokenBalance;

/** Resolve a USD price for a config, honouring `fixedPrice`. */
const resolvePrice = (
  cfg: CantonAssetConfig,
  prices: Record<string, { usd?: number } | undefined>,
): number => {
  if (typeof cfg.fixedPrice === "number") return cfg.fixedPrice;
  return prices?.[cfg.priceKey]?.usd ?? 1;
};


/** Hard cap for the whole assets load; the spinner never stays longer. */
const LOAD_TIMEOUT_MS = 30_000;
/** Cap for each individual Canton RPC call. */
const CANTON_CALL_TIMEOUT_MS = 10_000;

/** Incremented on every load so a stale (slower) run can't overwrite a newer one. */
let loadId = 0;

/** Native + token balances on Canton. Never throws; failed reads are skipped. */
const loadCantonEntries = async (
  owner: string,
  chainLabel: string,
  prices: Record<string, { usd?: number } | undefined>,
): Promise<TokenBalance[]> => {
  const entries: TokenBalance[] = [];

  /* ------------------------- Canton native balance ------------------------ */
  const nativeTask = (async () => {
    try {
      const raw = await withTimeout(
        getCantonBalance(),
        CANTON_CALL_TIMEOUT_MS,
        "Canton balance",
      );
      const qty = Number(formatEther(raw.toString()));
      const price = prices[chainIdToPriceId(31337)]?.usd ?? 1;
      if (qty > 0) {
        entries.unshift(buildCantonTokenEntry(NATIVE_CANTON, qty, price, chainLabel));
      }
    } catch (err) {
      console.warn("Failed to read Canton native balance", err);
    }
  })();

  /* --------------------- Canton ERC-20-style balances --------------------- */
  const tokensTask = (async () => {
    let provider: any;
    try {
      provider = (
        await withTimeout(
          getCantonNetworkProvider(),
          CANTON_CALL_TIMEOUT_MS,
          "Canton provider",
        )
      ).provider;
    } catch (err) {
      console.warn("Failed to get Canton provider", err);
      return;
    }

    const results = await Promise.allSettled(
      CANTON_ASSETS.map(async (cfg) => {
        const read = cfg.readBalance
          ? cfg.readBalance
          : (p: any, o: string) => readErc20Balance(p, cfg.address, o);
        const raw = await withTimeout(
          read(provider, owner),
          CANTON_CALL_TIMEOUT_MS,
          `Canton ${cfg.symbol}`,
        );
        return { cfg, qty: toDisplayQuantity(raw, cfg.decimals) };
      }),
    );

    // Keep the config order stable regardless of which call returned first.
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        // A single failing token should not break the whole page.
        console.warn(`Failed to read Canton balance for ${CANTON_ASSETS[i].symbol}`, r.reason);
        return;
      }
      const { cfg, qty } = r.value;
      if (qty <= 0) return;
      entries.push(
        buildCantonTokenEntry(cfg, qty, resolvePrice(cfg, prices), chainLabel),
      );
    });
  })();

  await Promise.all([nativeTask, tokensTask]);
  return entries;
};

const loadAssets = async (id: number) => {
  selectedAccount.value = await getSelectedAccount();
  selectedNetwork.value = await getSelectedNetwork();

  if (!selectedAccount.value) {
    noSelectedAccount.value = true;
    return;
  }

  isCanton.value =
    selectedNetwork.value?.chainId === 31337 ||
    selectedNetwork.value?.chainId === 30337;

  const owner = selectedAccount.value.address;
  const prices = await getPrices();
  // Same list the Networks tab shows: only scan chains the user has added.
  const networks = await getNetworks();
  const cantonChainId = selectedNetwork.value?.chainId === 30337 ? 30337 : 31337;
  const chainLabel = cantonChainId === 30337 ? "CANTON-TESTNET" : "CANTON";

  // EVM chains and Canton load in parallel; neither can block the other.
  const [portfolio, extras] = await Promise.all([
    getRpcPortfolio(owner, networks).catch((err) => {
      console.warn("Failed to load EVM portfolio", err);
      return null;
    }),
    networks[cantonChainId]
      ? loadCantonEntries(owner, chainLabel, prices)
      : Promise.resolve([] as TokenBalance[]),
  ]);

  if (id !== loadId) return; // a newer load started meanwhile

  // Only show the error if nothing at all could be loaded.
  if (!portfolio && extras.length === 0) {
    isError.value = true;
    return;
  }

  const baseTokens = (portfolio?.tokenBalances ?? []).filter(
    (t) => t.denominatedValue && !t.token?.project?.isSpam,
  );
  const evmTotal = portfolio?.tokensTotalDenominatedValue?.value ?? 0;

  // If the 30s cap already fired, late results still replace the error.
  isError.value = false;
  alltokens.value = [...extras, ...baseTokens];
  shownTokens.value = alltokens.value.slice(0, 10);

  const extrasTotal = extras.reduce(
    (sum, e) => sum + (e.denominatedValue?.value ?? 0),
    0,
  );

  assetsValue.value = {
    id: "total-value",
    value: evmTotal + extrasTotal,
  } as typeof assetsValue.value;

  assetsChange.value =
    portfolio?.tokensTotalDenominatedValueChange ??
    ({
      absolute: { id: "absolute-change", value: 0 },
      percentage: { id: "percentage-change", value: 0 },
    } as typeof assetsChange.value);

  noAssets.value = alltokens.value.length === 0;
};

onIonViewWillEnter(async () => {
  const id = ++loadId;

  // Reset state in case the view is re-entered.
  loading.value = true;
  isError.value = false;
  noSelectedAccount.value = false;
  noAssets.value = false;

  try {
    await withTimeout(loadAssets(id), LOAD_TIMEOUT_MS, "Assets load");
  } catch (err) {
    console.error("Failed to load assets", err);
    if (id === loadId) isError.value = true;
  } finally {
    // Always release the spinner, whatever happened above.
    if (id === loadId) loading.value = false;
  }
});
</script>

<style lang="scss" scoped>
.bridge-button {
  padding-top: 0.5rem;
  padding-bottom: 0.6rem;
  margin-top: 0.25rem;
  margin-bottom: 0.25rem;
  border-radius: 0.5rem;
  width: 100%;
  font-size: 0.9rem;
  line-height: 1.2rem;
  font-weight: 500;
  text-align: center;
  color: #fff;
  background-color: #312e81;
  padding-right: 1rem;
  padding-left: 1rem;
  box-shadow: 0 1px 3px #0000001a, 0 1px 2px #0000000f;

  svg {
    margin-right: 0.3rem;
    top: 0.3rem;
    display: inline-block;
    width: 1.3rem;
    position: relative;
  }
}

.bridge-button:hover {
  background-color: #37368f;
  transform: scale(1.05);
  transition: all 0.3s;
}

.warn-msg {
  text-align: center;
  font-size: 1.1rem;
  margin-top: 2.5rem;
}
</style>