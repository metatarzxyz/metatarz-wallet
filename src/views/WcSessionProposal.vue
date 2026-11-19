<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>Connect via WalletConnect</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-list v-if="req">
        <ion-item>
          <ion-avatar slot="start" v-if="req.peer.icon">
            <img :src="req.peer.icon" alt="" referrerpolicy="no-referrer" />
          </ion-avatar>
          <ion-text style="font-size: 0.9rem">
            <b>{{ req.peer.name }}</b>
            <div style="word-break: break-all">{{ req.peer.url || "No URL given" }}</div>
            <div style="font-size: 0.8rem; opacity: 0.8">
              via WalletConnect, wants to connect to your Canton wallet (CIP-0103)
            </div>
          </ion-text>
        </ion-item>

        <ion-item v-if="danger" color="danger">
          <ion-text style="font-size: 0.9rem">
            <b v-if="req.verify.isScam">This domain is flagged as a known scam.</b>
            <b v-else>The dApp's domain could not be verified: the request does not come
              from {{ req.peer.url || "the URL it claims" }}.</b>
            Connecting may let an attacker request transactions in your name. Only continue
            if you are certain.
          </ion-text>
        </ion-item>
        <ion-item v-else>
          <ion-text style="font-size: 0.9rem">
            WalletConnect Verify:
            <ion-text :color="req.verify.validation === 'VALID' ? 'success' : 'warning'">
              <b>{{ req.verify.validation === "VALID" ? "Verified domain" : "Unverified (unknown)" }}</b>
            </ion-text>
            <div v-if="req.verify.validation !== 'VALID'" style="font-size: 0.8rem">
              The dApp's domain could not be checked. Make sure you started this connection
              from {{ req.peer.url || "the dApp" }}.
            </div>
          </ion-text>
        </ion-item>
        <ion-item v-if="req.verify.origin && req.verify.origin !== req.peer.url">
          <ion-text style="font-size: 0.8rem; word-break: break-all">
            Verified origin: {{ req.verify.origin }}
          </ion-text>
        </ion-item>

        <ion-item>
          <ion-text style="font-size: 0.9rem">Canton network: <b>{{ req.networkId }}</b></ion-text>
        </ion-item>
        <ion-item>
          <ion-text style="font-size: 0.9rem">
            The dApp will see {{ req.parties.length > 1 ? "these Canton parties" : "this Canton party" }}
            and their public keys:
            <div v-for="p of req.parties" :key="p.partyId" style="margin-top: 0.4rem">
              <span v-if="p.name">{{ p.name }}{{ p.primary ? " (primary)" : "" }}:</span>
              <span v-else-if="p.primary">Primary:</span>
              <div style="word-break: break-all; font-size: 0.8rem"><b>{{ p.partyId }}</b></div>
            </div>
          </ion-text>
        </ion-item>
        <ion-item>
          <div style="width: 100%; font-size: 0.85rem">
            Methods the dApp can call:
            <ul style="margin: 0.3rem 0; padding-left: 1.2rem">
              <li v-for="m of req.methods" :key="m">
                {{ m }}<span v-if="APPROVAL_NEEDED.includes(m)"> (asks for your approval)</span>
              </li>
            </ul>
            <div v-if="extraRequested.length" style="opacity: 0.8">
              Requested but not supported: {{ extraRequested.join(", ") }}
            </div>
          </div>
        </ion-item>
        <ion-item>
          <ion-text style="font-size: 0.85rem">
            Ledger API reads for your party are answered without a popup. Transactions and
            message signatures always need your approval. You can disconnect the session at
            any time in Settings, WalletConnect.
          </ion-text>
        </ion-item>
        <ion-item>Auto-reject Timer:&nbsp;<b>{{ timerReject }}</b></ion-item>
        <ion-item class="no-inner-border">
          <ion-button @click="onCancel">Reject</ion-button>
          <ion-button v-if="danger && !confirmDanger" color="danger" @click="confirmDanger = true"
            >I understand the risk</ion-button
          >
          <ion-button v-else :color="danger ? 'danger' : 'primary'" @click="onConnect"
            >Connect</ion-button
          >
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
  IonAvatar,
  onIonViewWillEnter,
} from "@ionic/vue";
import { useRoute } from "vue-router";
import { approve, walletGetData, walletPing } from "@/extension/userRequest";
import type { WcPeer, WcVerify } from "@/extension/wcConstants";

// Request data comes from the service worker via wallet_get_data (keyed by this
// popup's window), never from the URL.
type Proposal = {
  kind: "wc-proposal";
  peer: WcPeer;
  verify: WcVerify;
  networkId: string;
  chain: string;
  parties: { partyId: string; primary: boolean; name: string }[];
  methods: string[];
  requestedMethods: string[];
  events: string[];
};

const APPROVAL_NEEDED = ["canton_prepareSignExecute", "canton_signMessage", "metatarz_swap"];

const route = useRoute();
const rid = (route?.params?.rid as string) ?? "";
const req = ref(null as Proposal | null);
const loadError = ref("");
const confirmDanger = ref(false);
const timerReject = ref(140);
let interval: any;

const danger = computed(
  () => !!req.value && (req.value.verify?.isScam === true || req.value.verify?.validation === "INVALID")
);
const extraRequested = computed(() =>
  (req.value?.requestedMethods ?? []).filter((m) => !(req.value?.methods ?? []).includes(m))
);

const loadRequest = async () => {
  for (let i = 0; i < 20; i++) {
    const data = (await walletGetData(rid)) as Proposal | undefined;
    if (data && data.kind === "wc-proposal") {
      req.value = data;
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  loadError.value = "The request could not be loaded.";
};

const onCancel = () => {
  if (interval) {
    clearInterval(interval);
  }
  window.close();
};

const onConnect = () => {
  if (!req.value || (danger.value && !confirmDanger.value)) return;
  if (interval) {
    clearInterval(interval);
  }
  approve(rid);
};

onIonViewWillEnter(() => {
  loadRequest();
  interval = setInterval(() => {
    if (timerReject.value <= 0) {
      onCancel();
      return;
    }
    timerReject.value -= 1;
    walletPing();
  }, 1000) as any;
});
</script>

<style scoped>
ion-item {
  --min-height: 30px;
  --padding-start: 8px;
  --padding-end: 8px;
}
</style>
