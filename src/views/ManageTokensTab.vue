<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>Manage Tokens</ion-title>
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

      <template v-if="noSelectedAccount">
        <p class="warn-msg">
          No account selected, please select or add an account to see manage tokens.
        </p>
      </template>

      <template v-else-if="noSelectedNetwork">
        <p class="warn-msg">
          Please select a Canton network to manage Canton tokens.
        </p>
      </template>
      <template v-else>
        <ion-list>
          <ion-item>
            <ion-label style="text-align: center">Canton Tokens</ion-label>
          </ion-item>

          <ion-alert
            :is-open="alertOpen"
            header="Error"
            :message="alertMsg"
            :buttons="['OK']"
            @didDismiss="alertOpen = false"
          ></ion-alert>
          <ion-list>
            <ion-item v-for="token of tokens" :key="token.address">
              <ion-avatar
                style="margin-right: 1rem; width: 1.6rem; height: 1.6rem"
              >
                <img
                  v-if="token.logoUrl"
                  :alt="token.name"
                  :src="token.logoUrl"
                />
                <img
                  v-else
                  :alt="token.name"
                  :src="getUrl('assets/randomGrad.svg')"
                />
              </ion-avatar>

              <ion-label class="flex-col flex">
                <div class="flex">
                  <b>{{ token.symbol }}</b>
                </div>
                <div class="flex">
                  <span style="font-size: 0.8rem; opacity: 0.7">
                    {{ token.name }}
                  </span>
                </div>
              </ion-label>

              <ion-button
                size="small"
                :fill="token.activated ? 'outline' : 'solid'"
                :disabled="
                  (token.symbol !== 'CC' && !tokens[0]?.activated) ||
                  token.activated ||
                  token.activating
                "
                @click="activateToken(token)"
              >
                {{ token.activated ? "Activated" : "Activate" }}
              </ion-button>
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
  IonLoading,
} from "@ionic/vue";
import {
  getAccounts,
  getNetworks,
  getSelectedAccount,
  getSelectedNetwork,
  getUrl,
  replaceAccounts,
  saveAccount,
  saveNetwork,
  saveSelectedAccount,
  saveSelectedNetwork,
  storageGet,
} from "@/utils/platform";
import type { Account, Network } from "@/extension/types";
import { registerWallet, sendPreapproval } from "@/utils/canton";

interface CantonToken {
  address: string;
  symbol: string;
  name: string;
  logoUrl?: string | null;
  activated: boolean;
  activating?: boolean;
  enabled?: boolean;
}

const selectedAccount = ref({}) as Ref<Account>;
const selectedNetwork = ref(null) as unknown as Ref<Network>;

const noSelectedAccount = ref(false);
const noSelectedNetwork = ref(false);

const loading = ref(true);
const tokens = ref<CantonToken[]>([]);
const alertMsg = ref("");
const alertOpen = ref(false);

const fetchCantonTokens = async (): Promise<CantonToken[]> => {
  const allNetworks = await getNetworks();

  const cantonNetwork = allNetworks[selectedNetwork.value.chainId];

  if (!cantonNetwork) {
    return [];
  }

  const cantonNetworkTokens =
    cantonNetwork?.tokens?.[selectedAccount.value.address]?.canton;

  return [
    {
      address: "0xDE30000000000000000000000000000000000001",
      symbol: "CC",
      name: "Amulet",
      logoUrl: getUrl("assets/chain-icons/canton.webp"),
      activated: cantonNetworkTokens?.cc?.activated || false,
    },
    {
      address: "0xDE60000000000000000000000000000000000001",
      symbol: "CBTC",
      name: "Canton wrapped Bitcoin",
      logoUrl: getUrl("assets/chain-icons/canton-cbtc.webp"),
      activated: cantonNetworkTokens?.cbtc?.activated || false,
    },
    {
      address: "0xDE70000000000000000000000000000000000001",
      symbol: "cETH",
      name: "Canton Ethereum",
      logoUrl: getUrl("assets/chain-icons/canton-ceth.webp"),
      activated: cantonNetworkTokens?.ceth?.activated || false,
    },
    {
      address: "0xDE40000000000000000000000000000000000001",
      symbol: "USDCx",
      name: "Canton USDC",
      logoUrl: getUrl("assets/chain-icons/canton-usdcx.webp"),
      activated: cantonNetworkTokens?.usdcx?.activated || false,
    },
    {
      address: "0xDE50000000000000000000000000000000000001",
      symbol: "HANDL",
      name: "HANDL",
      logoUrl: getUrl("assets/chain-icons/canton-handl.webp"),
      activated: cantonNetworkTokens?.handl?.activated || false,
    },
  ];
};

const activateTokenRequest = async (symbol: string): Promise<void> => {
  try {
    loading.value = true;
    if (symbol === "CC") {
      //try to register wallet

      const cantonData = await registerWallet(selectedAccount.value.pk);

      if (cantonData?.error) {
        alertMsg.value =
          "Failed to register Canton wallet: " + cantonData.error;
        alertOpen.value = true;
        return;
      }

      const updatedAccount: Account = {
        ...selectedAccount.value,
        cantonParty: cantonData?.party,
        cantonFingerprint: cantonData?.fingerprint,
      };

      const accounts = await getAccounts();

      if (accounts && accounts.length > 1) {
        const nonSelectedAccounts = accounts.filter(
          (a) => a.address !== selectedAccount.value.address
        );

        await replaceAccounts([updatedAccount, ...nonSelectedAccounts]);
      } else {
        await saveAccount(updatedAccount);
      }

      await saveSelectedAccount(updatedAccount);

      //save network
      const currentCanton =
        selectedNetwork.value.tokens?.[selectedAccount.value.address]?.canton ??
        {};

      const updatedNetwork: Network = {
        ...selectedNetwork.value,
        tokens: {
          ...selectedNetwork.value.tokens,
          [selectedAccount.value.address]: {
            canton: {
              ...currentCanton,
              cc: {
                activated: true,
              },
            },
          },
        },
      };
      selectedNetwork.value = updatedNetwork

      await saveNetwork(updatedNetwork);
      await saveSelectedNetwork(updatedNetwork);

      //send Amulet preapproval
      await sendPreapproval(
        "preapproval",
        selectedAccount.value.cantonParty!,
        selectedAccount.value.pk
      );
    }

    if (symbol === "CBTC") {
      await sendPreapproval(
        "preapproval2",
        selectedAccount.value.cantonParty!,
        selectedAccount.value.pk
      );

      const currentCanton =
        selectedNetwork.value.tokens?.[selectedAccount.value.address]?.canton ??
        {};

      const updatedNetwork: Network = {
        ...selectedNetwork.value,
        tokens: {
          ...selectedNetwork.value.tokens,
          [selectedAccount.value.address]: {
            canton: {
              ...currentCanton,
              cbtc: {
                activated: true,
              },
            },
          },
        },
      };

      selectedNetwork.value = updatedNetwork
      await saveNetwork(updatedNetwork);
      await saveSelectedNetwork(updatedNetwork);
    }

    if (symbol === "cETH") {
      await sendPreapproval(
        "preapproval3",
        selectedAccount.value.cantonParty!,
        selectedAccount.value.pk
      );
      const currentCanton =
        selectedNetwork.value.tokens?.[selectedAccount.value.address]?.canton ??
        {};
      const updatedNetwork: Network = {
        ...selectedNetwork.value,
        tokens: {
          ...selectedNetwork.value.tokens,
          [selectedAccount.value.address]: {
            canton: {
              ...currentCanton,
              ceth: {
                activated: true,
              },
            },
          },
        },
      };
      selectedNetwork.value = updatedNetwork
      await saveNetwork(updatedNetwork);
      await saveSelectedNetwork(updatedNetwork);
    }
    if (symbol === "USDCx") {
      await sendPreapproval(
        "preapproval4",
        selectedAccount.value.cantonParty!,
        selectedAccount.value.pk
      );

      const currentCanton =
        selectedNetwork.value.tokens?.[selectedAccount.value.address]?.canton ??
        {};
      const updatedNetwork: Network = {
        ...selectedNetwork.value,
        tokens: {
          ...selectedNetwork.value.tokens,
          [selectedAccount.value.address]: {
            canton: {
              ...currentCanton,
              usdcx: {
                activated: true,
              },
            },
          },
        },
      };
      selectedNetwork.value = updatedNetwork
      await saveNetwork(updatedNetwork);
      await saveSelectedNetwork(updatedNetwork);
    }

    if (symbol === "HANDL") {
      await sendPreapproval(
        "preapproval5",
        selectedAccount.value.cantonParty!,
        selectedAccount.value.pk
      );

      const currentCanton =
        selectedNetwork.value.tokens?.[selectedAccount.value.address]?.canton ??
        {};
      const updatedNetwork: Network = {
        ...selectedNetwork.value,
        tokens: {
          ...selectedNetwork.value.tokens,
          [selectedAccount.value.address]: {
            canton: {
              ...currentCanton,
              handl: {
                activated: true,
              },
            },
          },
        },
      };
      selectedNetwork.value = updatedNetwork
      await saveNetwork(updatedNetwork);
      await saveSelectedNetwork(updatedNetwork);
    }
    return;
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
};

const activateToken = async (token: CantonToken) => {
  if (token.activated || token.activating || !selectedAccount) return;

  try {
    token.activating = true;
    await activateTokenRequest(token.symbol);
    tokens.value = await fetchCantonTokens();
  } finally {
    token.activating = false;
  }
};

onIonViewWillEnter(async () => {
  loading.value = true;
  selectedAccount.value = await getSelectedAccount();

  if (!selectedAccount.value) {
    noSelectedAccount.value = true;
    loading.value = false;
    return;
  } else {
    noSelectedAccount.value = false;
  }

  selectedNetwork.value = await getSelectedNetwork();

  if (
    !(selectedNetwork.value && [30337, 31337].includes(selectedNetwork.value.chainId))
  ) {
    noSelectedNetwork.value = true;
    loading.value = false;
    return;
  } else {
    noSelectedNetwork.value = false;
  }

  try {
    tokens.value = await fetchCantonTokens();
  } finally {
    loading.value = false;
  }
});
</script>

<style lang="scss" scoped>
.warn-msg {
  text-align: center;
  font-size: 1.1rem;
  margin-top: 2.5rem;
}
</style>