<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>WalletConnect (Canton)</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <ion-list v-if="!supported">
        <ion-item>
          <ion-text color="warning" style="font-size: 0.9rem">
            {{ unsupportedReason || "WalletConnect is not available in this browser." }}
          </ion-text>
        </ion-item>
      </ion-list>
      <template v-else>
        <ion-list>
          <ion-item>
            <ion-input
              label="WalletConnect link"
              label-placement="stacked"
              placeholder="wc:..."
              v-model="uri"
              :clear-input="true"
            ></ion-input>
          </ion-item>
          <ion-item v-if="pairError" class="no-inner-border">
            <ion-text color="danger" style="font-size: 0.85rem">{{ pairError }}</ion-text>
          </ion-item>
          <ion-item v-if="pairInfo" class="no-inner-border">
            <ion-text color="success" style="font-size: 0.85rem">{{ pairInfo }}</ion-text>
          </ion-item>
          <ion-item class="no-inner-border">
            <ion-button @click="pastFromClipboard" fill="outline">Paste</ion-button>
            <ion-button @click="connect" :disabled="pairing || !uri.trim()">Connect</ion-button>
          </ion-item>
        </ion-list>
        <p class="helper-label">
          In the dApp choose WalletConnect, copy its connection link (it starts with
          "wc:") and paste it here. You approve the connection in a popup. Only the
          Canton dApp API (CIP-0103) is available over WalletConnect.
        </p>
      </template>

      <ion-list>
        <ion-list-header>
          <ion-label>Active sessions</ion-label>
        </ion-list-header>
        <ion-item v-if="!sessions.length" class="no-inner-border">
          <ion-label style="font-size: 0.85rem">No WalletConnect sessions.</ion-label>
        </ion-item>
        <ion-item v-for="s of sessions" :key="s.topic">
          <ion-avatar slot="start" v-if="s.peer.icon">
            <img :src="s.peer.icon" alt="" referrerpolicy="no-referrer" />
          </ion-avatar>
          <ion-label style="font-size: 0.85rem; white-space: normal">
            <b>{{ s.peer.name }}</b>
            <div style="word-break: break-all">{{ s.peer.url || "No URL" }}</div>
            <div>
              Verify:
              <ion-text :color="verifyColor(s.verify)">{{ verifyLabel(s.verify) }}</ion-text>
            </div>
            <div style="word-break: break-all">Networks: {{ s.chains.join(", ") }}</div>
            <div>Parties: {{ s.accounts.length }}</div>
          </ion-label>
          <ion-button slot="end" color="warning" @click="disconnect(s.topic)">Disconnect</ion-button>
        </ion-item>
      </ion-list>
      <ion-loading :is-open="pairing" message="Connecting..." />
      <ion-toast
        :is-open="toastState"
        @didDismiss="toastState = false"
        :message="toastMsg"
        :duration="1500"
      ></ion-toast>
    </ion-content>
  </ion-page>
</template>

<script lang="ts" setup>
import { ref } from "vue";
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButton,
  IonContent,
  IonList,
  IonListHeader,
  IonItem,
  IonLabel,
  IonInput,
  IonText,
  IonAvatar,
  IonLoading,
  IonToast,
  onIonViewWillEnter,
  onIonViewWillLeave,
} from "@ionic/vue";
import { isWcUri, type WcSessionRecord, type WcVerify } from "@/extension/wcConstants";

const supported = ref(true);
const unsupportedReason = ref("");
const uri = ref("");
const pairing = ref(false);
const pairError = ref("");
const pairInfo = ref("");
const sessions = ref([] as WcSessionRecord[]);
const toastState = ref(false);
const toastMsg = ref("");

const send = (method: string, params?: unknown) =>
  new Promise<any>((resolve) => {
    chrome.runtime.sendMessage({ type: "CLWALLET_CONTENT_MSG", method, params }, (r) => {
      if (chrome.runtime.lastError) {
        console.warn("WalletConnect UI:", chrome.runtime.lastError);
      }
      resolve(r);
    });
  });

const verifyLabel = (v: WcVerify) =>
  v?.isScam ? "Known scam" : v?.validation === "VALID" ? "Verified" : v?.validation === "INVALID" ? "Domain mismatch" : "Unverified";

const verifyColor = (v: WcVerify) =>
  v?.isScam || v?.validation === "INVALID" ? "danger" : v?.validation === "VALID" ? "success" : "warning";

const loadSessions = async () => {
  const list = await send("wc_sessions");
  sessions.value = Array.isArray(list) ? list : [];
};

const pastFromClipboard = async () => {
  try {
    uri.value = (await navigator.clipboard.readText()).trim();
  } catch {
    pairError.value = "Could not read the clipboard. Paste the link into the field.";
  }
};

const connect = async () => {
  pairError.value = "";
  pairInfo.value = "";
  const value = uri.value.trim();
  if (!isWcUri(value)) {
    pairError.value = 'This is not a WalletConnect v2 link: it must start with "wc:" and contain "@2".';
    return;
  }
  pairing.value = true;
  try {
    const res = await send("wc_pair", { uri: value });
    if (res?.ok) {
      uri.value = "";
      pairInfo.value = "Link accepted. Approve the connection in the popup window.";
    } else {
      pairError.value = String(res?.error ?? "Could not connect.");
    }
  } finally {
    pairing.value = false;
  }
};

const disconnect = async (topic: string) => {
  await send("wc_disconnect", { topic });
  await loadSessions();
  toastMsg.value = "Session disconnected";
  toastState.value = true;
};

// Sessions are added by the approval popup and removed by the dApp: follow the store
const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
  if (area === "local" && "walletconnectSessions" in changes) {
    loadSessions();
  }
};

onIonViewWillEnter(async () => {
  const status = await send("wc_status");
  supported.value = status?.supported === true;
  unsupportedReason.value = String(status?.reason ?? "");
  await loadSessions();
  chrome.storage.onChanged.addListener(onStorage);
});

onIonViewWillLeave(() => {
  chrome.storage.onChanged.removeListener(onStorage);
});
</script>

<style scoped>
.helper-label {
  font-size: 0.82rem;
  opacity: 0.85;
  margin: 0.2rem 0 0.6rem 0;
}
</style>
