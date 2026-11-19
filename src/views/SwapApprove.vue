<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>Canton Swap</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-list v-if="req">
        <ion-item v-if="isWc">
          <ion-text style="font-size: 0.9rem">
            Request from:
            <b>{{ req.peer?.name || "Unknown dApp" }}</b> via WalletConnect
            <div style="word-break: break-all">
              <b>{{ req.peer?.url || "No URL given" }}</b>
            </div>
          </ion-text>
        </ion-item>
        <ion-item v-if="isWc" :color="wcDanger ? 'danger' : undefined">
          <ion-text style="font-size: 0.9rem">
            WalletConnect Verify:
            <b v-if="req.peer?.verify?.isScam">known scam domain</b>
            <b v-else-if="req.peer?.verify?.validation === 'INVALID'"
              >domain mismatch, this may not be {{ req.peer?.url }}</b
            >
            <ion-text v-else-if="req.peer?.verify?.validation === 'VALID'" color="success"
              ><b>verified domain</b></ion-text
            >
            <ion-text v-else color="warning"><b>unverified</b></ion-text>
          </ion-text>
        </ion-item>
        <ion-item v-else>
          <ion-text style="font-size: 0.9rem">
            Request from:
            <b style="word-break: break-all">{{ req.origin || "Unknown site" }}</b>
          </ion-text>
        </ion-item>
        <ion-item v-if="req.subframe">
          <ion-text color="warning" style="font-size: 0.9rem">
            This request comes from an embedded frame, not from the page shown in the
            address bar. Only approve if you trust this site.
          </ion-text>
        </ion-item>
        <ion-item v-if="!isWc && (req.origin ?? '').startsWith('http:')">
          <ion-text color="warning" style="font-size: 0.9rem">
            This site does not use a secure (https) connection.
          </ion-text>
        </ion-item>
        <ion-item>
          <ion-text style="font-size: 0.9rem">
            Network: <b>{{ req.networkId }}</b>
          </ion-text>
        </ion-item>
        <ion-item>
          <ion-text style="font-size: 0.9rem">
            Account
            <span v-if="req.accountName">({{ req.accountName }})</span>:
            <div style="word-break: break-all; font-size: 0.8rem">
              <b>{{ req.party }}</b>
            </div>
          </ion-text>
        </ion-item>

        <ion-item>
          <ion-text style="font-size: 1rem">
            You pay:
            <b class="amount">{{ fmt(req.amount) }} {{ sym(req.from) }}</b>
          </ion-text>
        </ion-item>
        <ion-item>
          <ion-text style="font-size: 1rem">
            You receive at least:
            <b class="amount">{{ fmt(req.minAmountOut) }} {{ sym(req.to) }}</b>
          </ion-text>
        </ion-item>
        <ion-item>
          <ion-text v-if="req.quote" style="font-size: 0.9rem">
            Estimated (wallet's own quote):
            <b class="amount">{{ fmt(req.quote.amountOut) }} {{ sym(req.to) }}</b>
            <div style="font-size: 0.8rem; opacity: 0.85">
              Rate: 1 {{ sym(req.from) }} ≈ {{ req.quote.rate }} {{ sym(req.to) }}, spread
              {{ spreadPercent }}%
            </div>
          </ion-text>
          <ion-text v-else color="warning" style="font-size: 0.9rem">
            Estimated: the wallet could not get its own quote ({{
              req.quoteError || "unavailable"
            }}). Check the minimum you receive carefully.
          </ion-text>
        </ion-item>
        <ion-item v-if="highSlippage" color="danger">
          <ion-text style="font-size: 0.95rem">
            <b>High slippage tolerance set by the site.</b>
            <div style="font-size: 0.85rem">
              The minimum you receive is {{ minPercentOfQuote }}% of the wallet's estimate. You
              may get much less than estimated.
            </div>
          </ion-text>
        </ion-item>
        <ion-item>
          <ion-text style="font-size: 0.85rem; opacity: 0.9">
            The price is fixed when you approve, and the swap expires shortly after. If the
            price has moved below your minimum, the swap is not made.
          </ion-text>
        </ion-item>

        <ion-item v-if="needsActivation" color="warning">
          <ion-text style="font-size: 0.95rem">
            <b
              >You haven't activated {{ req.activationSymbol }} in this wallet. To receive it,
              Metatarz will first activate {{ req.activationSymbol }} (creates a transfer
              preapproval), then run the swap.</b
            >
          </ion-text>
        </ion-item>
        <ion-item v-if="activationError" color="danger">
          <ion-text style="font-size: 0.9rem">
            <b>Activating {{ req.activationSymbol }} failed.</b>
            <div style="word-break: break-word">{{ activationError }}</div>
            <div>The swap was not made. You can try again or reject.</div>
          </ion-text>
        </ion-item>

        <ion-item>Auto-reject Timer:&nbsp;<b>{{ timerReject }}</b></ion-item>
        <ion-item class="no-inner-border">
          <ion-button @click="onCancel">Reject</ion-button>
          <ion-button v-if="wcDanger && !confirmDanger" color="danger" @click="confirmDanger = true"
            >I understand the risk</ion-button
          >
          <ion-button v-else :disabled="loading" @click="onApprove">{{
            needsActivation ? `Activate ${req.activationSymbol} & swap` : "Approve"
          }}</ion-button>
        </ion-item>
      </ion-list>
      <ion-list v-else>
        <ion-item>
          <ion-text>{{ loadError || "Loading request..." }}</ion-text>
        </ion-item>
        <ion-item class="no-inner-border">
          <ion-button @click="onCancel">Reject</ion-button>
        </ion-item>
      </ion-list>
      <ion-loading
        :is-open="loading"
        :message="loadingMessage"
        :key="`k${loading}`"
        @didDismiss="loading = false"
      />
    </ion-content>
  </ion-page>
</template>

<script lang="ts" setup>
import { ref, computed } from "vue";
import {
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  IonItem,
  IonButton,
  IonText,
  IonList,
  IonLoading,
  modalController,
  onIonViewWillEnter,
} from "@ionic/vue";
import { useRoute } from "vue-router";
import { approve, walletGetData, walletPing, walletSendData } from "@/extension/userRequest";
import { blockLockout, getAccounts, getNetworks, unBlockLockout } from "@/utils/platform";
import UnlockModal from "@/views/UnlockModal.vue";
import { setUnlockModalState } from "@/utils/unlockStore";
import type { WcPeer, WcVerify } from "@/extension/wcConstants";
import { formatSwapAmount, isHighSlippage, swapSymbolLabel } from "@/utils/swap";
import {
  activateToken,
  getStoredCantonNetwork,
  isTokenActivated,
  tokenKeyOfPoolSymbol,
} from "@/utils/cantonActivation";

// Request data comes from the service worker via wallet_get_data (keyed by this
// popup's window), never from the URL.
type SwapRequest = {
  kind: "swap";
  origin: string;
  subframe: boolean;
  networkId: string;
  party: string;
  accountName: string;
  address: string;
  from: string;
  to: string;
  amount: string; // wei
  minAmountOut: string; // wei
  quote?: { amountOut: string; rate: string; spreadBps: number };
  quoteError?: string;
  chainId: number; // active Canton network
  // The `to` asset is not activated: activate it (transfer preapproval) before approving
  needsActivation?: boolean;
  activationSymbol?: string;
  via?: "walletconnect";
  peer?: WcPeer & { verify: WcVerify };
};

const route = useRoute();
const rid = (route?.params?.rid as string) ?? "";

const req = ref(null as SwapRequest | null);
const loadError = ref("");
const confirmDanger = ref(false);
const isWc = computed(() => req.value?.via === "walletconnect");
const wcDanger = computed(
  () =>
    isWc.value &&
    (req.value?.peer?.verify?.isScam === true || req.value?.peer?.verify?.validation === "INVALID")
);
const loading = ref(false);
const loadingMessage = ref("Please wait...");
// Set once `to` was activated from this popup (a retry then only approves)
const activationDone = ref(false);
const activationError = ref("");
const needsActivation = computed(() => !!req.value?.needsActivation && !activationDone.value);
const timerReject = ref(140);
let interval: any;

const fmt = (wei: string) => formatSwapAmount(wei);
const sym = (symbol: string) => swapSymbolLabel(symbol);

const spreadPercent = computed(() => ((req.value?.quote?.spreadBps ?? 0) / 100).toFixed(2));
const highSlippage = computed(
  () => !!req.value?.quote && isHighSlippage(req.value.minAmountOut, req.value.quote.amountOut)
);
const minPercentOfQuote = computed(() => {
  try {
    const q = BigInt(req.value?.quote?.amountOut ?? "0");
    if (q <= 0n) return "0";
    const bps = (BigInt(req.value?.minAmountOut ?? "0") * 10000n) / q;
    return (Number(bps) / 100).toFixed(2);
  } catch {
    return "?";
  }
});

const loadRequest = async () => {
  // The service worker stores the data right after it opens this window: retry briefly
  for (let i = 0; i < 20; i++) {
    const data = (await walletGetData(rid)) as SwapRequest | undefined;
    if (data && data.kind === "swap") {
      req.value = data;
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  loadError.value = "The request could not be loaded.";
};

const onCancel = async () => {
  if (interval) {
    clearInterval(interval);
  }
  // Lift the auto-lock suspension before the window (and this script) goes away
  try {
    await unBlockLockout();
  } catch {
    // ignore
  }
  window.close();
};

const openModal = async () => {
  const modal = await modalController.create({
    component: UnlockModal,
    animated: true,
    focusTrap: false,
    backdropDismiss: false,
    componentProps: {
      unlockType: "transaction",
    },
  });
  await modal.present();
  setUnlockModalState(true);
  const { role } = await modal.onWillDismiss();
  if (role === "confirm") return true;
  await setUnlockModalState(false);
  return false;
};

const startTimer = () => {
  if (interval) {
    clearInterval(interval);
  }
  interval = setInterval(async () => {
    if (timerReject.value <= 0) {
      onCancel();
      return;
    }
    timerReject.value -= 1;
    walletPing();
  }, 1000) as any;
};

// Creates the transfer preapproval of the `to` asset with the unlocked key, from
// this popup (the service worker only runs the swap after approval). Returns false
// on failure, with the error shown.
const activateToAsset = async (): Promise<boolean> => {
  const r = req.value;
  if (!r) return false;
  const key = tokenKeyOfPoolSymbol(r.to);
  if (!key) return true;
  activationError.value = "";
  loadingMessage.value = `Activating ${r.activationSymbol}…`;
  loading.value = true;
  // Keep the service worker (and its pending request) alive while activating
  const ping = setInterval(() => walletPing(), 1000);
  try {
    // Renew the auto-lock lease for the duration of the activation
    await blockLockout();
    const address = r.address.toLowerCase();
    const account = (await getAccounts()).find((a) => a.address.toLowerCase() === address);
    if (!account || (account.pk ?? "").length !== 66) {
      throw new Error("The wallet is locked");
    }
    const network = await getStoredCantonNetwork(r.chainId, await getNetworks());
    if (!network) {
      throw new Error("The Canton network is not configured in the wallet");
    }
    if (!isTokenActivated(network, account.address, key)) {
      await activateToken({
        network,
        account: { address: account.address, pk: account.pk, cantonParty: account.cantonParty },
        key,
      });
    }
    activationDone.value = true;
    return true;
  } catch (e) {
    console.error(e);
    activationError.value = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    clearInterval(ping);
    loading.value = false;
    loadingMessage.value = "Please wait...";
  }
};

const onApprove = async () => {
  if (!req.value || loading.value || (wcDanger.value && !confirmDanger.value)) return;
  loading.value = true;
  if (interval) {
    clearInterval(interval);
  }
  const address = req.value.address.toLowerCase();
  const signer = (await getAccounts()).find((a) => a.address.toLowerCase() === address);
  loading.value = false;
  if ((signer?.pk ?? "").length !== 66) {
    const modalResult = await openModal();
    if (!modalResult) {
      // The site gets "wallet locked" (4100) rather than "user rejected"
      await walletSendData(rid, { unlockCancelled: true });
      onCancel();
      return;
    }
  }
  if (needsActivation.value && !(await activateToAsset())) {
    // Not approved: no swap. The user can retry or reject.
    timerReject.value = Math.max(timerReject.value, 60);
    startTimer();
    return;
  }
  await unBlockLockout(true);
  approve(rid);
};

onIonViewWillEnter(async () => {
  blockLockout();
  loadRequest();
  startTimer();
});
</script>

<style scoped>
ion-item {
  --min-height: 30px;
  --padding-start: 8px;
  --padding-end: 8px;
}
.amount {
  word-break: break-all;
}
</style>
