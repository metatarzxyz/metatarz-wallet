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
                  v-else-if="token?.token?.name === 'Canton Network'"
                  :alt="token?.token?.name"
                  :src="getUrl('assets/chain-icons/canton.webp')"
                />

                <img
                  v-else-if="token?.token?.name === 'Canton wrapped Bitcoin'"
                  :alt="token?.token?.name"
                  :src="getUrl('assets/chain-icons/canton-cbtc.webp')"
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
                  {{ formatNumber(token?.quantity, 4) }}
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
} from "@/utils/platform";
import type {
  Account,
  Network,
  UniSwapPortfolioResponse,
} from "@/extension/types";
import { formatNumber, getBalance, getCurrentProvider } from "@/utils/wallet";
import ArrowDown from "@/components/icons/ArrowDown.vue";
import ArrowUp from "@/components/icons/ArrowUp.vue";
import { copyOutline } from "ionicons/icons";
import BridgeIcon from "@/components/icons/Bridge.vue";
import { formatEther, formatUnits } from "ethers";
import { I } from "vue-router/dist/router-CWoNjPRp.mjs";
import { chainIdToPriceId } from "@/utils/networks";

const selectedAccount = ref({}) as Ref<Account>;
const loading = ref(true);
const isError = ref(false);
const noSelectedAccount = ref(false);
const noAssets = ref(false);
const toastState = ref(false);
const getToastRef = () => toastState;
const isCanton = ref(false);
const selectedNetwork = ref(null) as unknown as Ref<Network>;

const alltokens = ref({}) as Ref<
  UniSwapPortfolioResponse["data"]["portfolios"][0]["tokenBalances"]
>;
const shownTokens = ref([]) as Ref<
  UniSwapPortfolioResponse["data"]["portfolios"][0]["tokenBalances"]
>;

const assetsValue = ref({}) as Ref<
  UniSwapPortfolioResponse["data"]["portfolios"][0]["tokensTotalDenominatedValue"]
>;

const assetsChange = ref({}) as Ref<
  UniSwapPortfolioResponse["data"]["portfolios"][0]["tokensTotalDenominatedValueChange"]
>;

const UNISWAP_API_ENDPOINT = "https://interface.gateway.uniswap.org/v1/graphql";

const getUniwapAssets = async (ownerAddress: string) => {
  const headers = {
    "user-agent": "Desktop",
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    dnt: "1",
    "Content-Type": "application/json",
    origin: "https://app.uniswap.org",
    referer: "https://app.uniswap.org/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "sec-gpc": "1",
  };

  const query = {
    operationName: "PortfolioBalancesWeb",
    variables: {
      includeSmallBalances: false,
      includeSpamTokens: false,
      ownerAddress,
      chains: [
        "ETHEREUM",
        "OPTIMISM",
        "BNB",
        "POLYGON",
        "ZKSYNC",
        "BASE",
        "ARBITRUM",
        "CELO",
        "AVALANCHE",
        "BLAST",
        "ZORA",
        "MONAD",
      ],
    },
    query:
      "query PortfolioBalancesWeb($ownerAddress: String!, $chains: [Chain!]!, $includeSmallBalances: Boolean = false, $includeSpamTokens: Boolean = false) {\n  portfolios(\n    ownerAddresses: [$ownerAddress]\n    chains: $chains\n    valueModifiers: [{ownerAddress: $ownerAddress, includeSpamTokens: $includeSpamTokens, includeSmallBalances: $includeSmallBalances}]\n  ) {\n    id\n    tokensTotalDenominatedValue {\n      id\n      value\n      __typename\n    }\n    tokensTotalDenominatedValueChange(duration: DAY) {\n      absolute {\n        id\n        value\n        __typename\n      }\n      percentage {\n        id\n        value\n        __typename\n      }\n      __typename\n    }\n    tokenBalances {\n      ...PortfolioTokenBalanceParts\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment PortfolioTokenBalanceParts on TokenBalance {\n  id\n  quantity\n  denominatedValue {\n    id\n    currency\n    value\n    __typename\n  }\n  token {\n    ...SimpleTokenDetails\n    id\n    address\n    chain\n    symbol\n    name\n    decimals\n    standard\n    project {\n      id\n      name\n      logo {\n        id\n        url\n        __typename\n      }\n      safetyLevel\n      logoUrl\n      isSpam\n      __typename\n    }\n    __typename\n  }\n  tokenProjectMarket {\n    id\n    pricePercentChange(duration: DAY) {\n      id\n      value\n      __typename\n    }\n    tokenProject {\n      id\n      logoUrl\n      isSpam\n      __typename\n    }\n    __typename\n  }\n  __typename\n}\n\nfragment SimpleTokenDetails on Token {\n  id\n  address\n  chain\n  symbol\n  name\n  decimals\n  standard\n  project {\n    id\n    name\n    logo {\n      id\n      url\n      __typename\n    }\n    safetyLevel\n    logoUrl\n    isSpam\n    __typename\n  }\n  __typename\n}",
  };

  const req = await fetch(UNISWAP_API_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(query),
  });

  if (!req.ok) {
    return null;
  }

  const res = await req.json();
  return res as UniSwapPortfolioResponse;
};

onIonViewWillEnter(async () => {
  selectedAccount.value = await getSelectedAccount();
  selectedNetwork.value = await getSelectedNetwork();
  if (!selectedAccount.value) {
    noSelectedAccount.value = true;
    loading.value = false;
    return;
  }

  if (selectedNetwork.value.chainId === 31337) {
    isCanton.value = true;
  } else {
    isCanton.value = false;
  }

  const result = await getUniwapAssets(selectedAccount.value.address);

  if (!result) {
    isError.value = true;
    loading.value = false;
    return;
  }


  const prices = await getPrices();
  const cantoncoindinusd = prices[chainIdToPriceId(31337)]?.usd ?? 1;
  const bitcoininusd = prices['bitcoin']?.usd ?? 1

  const cantonBalance = Number(formatEther((await getBalance()).toString()));

  const cantonEntry = {
    id: "canton-native-balance",
    quantity: cantonBalance,
    denominatedValue: { value: +(cantonBalance *  cantoncoindinusd).toFixed(2) },
    token: {
      id: "canton-native",
      address: "native",
      chain: "Canton",
      symbol: "CC",
      name: "Canton Network",
      decimals: 9,
      standard: "NATIVE",
      project: {
        id: "canton",
        name: "Canton Network",
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
  };

  const cantonTokens = [
  { address: "0xDE40000000000000000000000000000000000001", symbol: "USDCx" },
  { address: "0xDE50000000000000000000000000000000000001", symbol: "HANDL" },
  { address: "0xDE60000000000000000000000000000000000001", symbol: "CBTC" },
  { address: "0xDE70000000000000000000000000000000000001", symbol: "CETH" },
];

  //fetch cbtc balance
  const provider = (await getCurrentProvider()).provider;

  const tokenAddress = cantonTokens[2].address


  const address = selectedAccount.value.address.toLowerCase();
  const addressWithoutPrefix = address.startsWith("0x")
    ? address.slice(2)
    : address;
  const paddedAddress = addressWithoutPrefix.padStart(64, "0");
  const data = `0x70a08231${paddedAddress}`;

  // Make the eth_call
  const resultCall = await provider.send("eth_call", [
    {
      to: tokenAddress,
      data: data,
    },
    "latest",
  ]);

  const balanceHex = resultCall;

  let balance: bigint;
  if (balanceHex === "0x" || balanceHex === "0x0") {
    balance = 0n;
  } else {
    balance = BigInt(balanceHex);
  }

  const formattedBalance = Number(formatUnits(balance, 18));
  const cbtcBalance = Math.round(formattedBalance * 10000) / 10000;


  const cantonCbtcEntry = {
    id: "canton-cbtc-balance",
    quantity: cbtcBalance,
    denominatedValue: { value: +(cbtcBalance *  bitcoininusd).toFixed(2)},
    token: {
      id: "canton-cbtc-native",
      address: "native",
      chain: "Canton",
      symbol: "CBTC",
      name: "Canton wrapped Bitcoin",
      decimals: 9,
      standard: "NATIVE",
      project: {
        id: "bitcoin",
        name: "Bitcoin",
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
  };



  if (result?.data?.portfolios?.length) {
    alltokens.value = result.data.portfolios[0].tokenBalances.filter(
      (token) => token.denominatedValue && !token.token.project.isSpam
    );

    // Add Canton balance if > 0
    if (cantonBalance > 0) {
      alltokens.value = [cantonEntry, ...alltokens.value];
    }

    //add cbtc bal
    if(cbtcBalance > 0){
      alltokens.value = [cantonCbtcEntry, ...alltokens.value];

    }
  } else {
    alltokens.value = cantonBalance > 0 ? [cantonEntry] : [];
    alltokens.value = cbtcBalance > 0 ? [cantonCbtcEntry] : [];

  }

  shownTokens.value = alltokens.value.slice(0, 10);

  // Update total value to include Canton balance


  const uniswapTotal =
    result?.data?.portfolios?.[0]?.tokensTotalDenominatedValue?.value || 0;
  assetsValue.value = {
    id: "total-value",
    value: uniswapTotal + +(cantonBalance * cantoncoindinusd).toFixed(2)
    + +(cbtcBalance * bitcoininusd).toFixed(2)
    ,
  };

  assetsChange.value = result?.data?.portfolios?.[0]
    ?.tokensTotalDenominatedValueChange || {
    absolute: { id: "absolute-change", value: 0 },
    percentage: { id: "percentage-change", value: 0 },
  };

  noAssets.value = alltokens.value.length === 0;
  loading.value = false;
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
