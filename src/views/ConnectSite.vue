<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ canton ? "Connect Site (Canton)" : "Connect Site" }}</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-list>
        <ion-item>
          <ion-text>
            <b style="word-break: break-all">{{ origin || "Unknown site" }}</b>
            {{
              canton
                ? "wants to connect to your Canton wallet (Canton dApp API, CIP-0103)"
                : "wants to connect to your wallet"
            }}
          </ion-text>
        </ion-item>
        <ion-item v-if="subframe">
          <ion-text color="warning" style="font-size: 0.9rem">
            This request comes from an embedded frame, not from the page shown in the
            address bar. Only connect if you trust this site.
          </ion-text>
        </ion-item>
        <ion-item v-if="origin.startsWith('http:')">
          <ion-text color="warning" style="font-size: 0.9rem">
            This site does not use a secure (https) connection.
          </ion-text>
        </ion-item>
        <template v-if="canton">
          <ion-item v-if="networkId">
            <ion-text style="font-size: 0.9rem">Canton network: <b>{{ networkId }}</b></ion-text>
          </ion-item>
          <ion-item>
            <ion-text style="font-size: 0.9rem">
              The site will see {{ parties.length > 1 ? "these Canton parties" : "this Canton party" }}
              and their public keys:
              <div v-for="p of parties" :key="p.partyId" style="margin-top: 0.4rem">
                <span v-if="p.name">{{ p.name }}{{ p.primary ? " (primary)" : "" }}:</span>
                <span v-else-if="p.primary">Primary:</span>
                <div style="word-break: break-all; font-size: 0.8rem"><b>{{ p.partyId }}</b></div>
              </div>
            </ion-text>
          </ion-item>
          <ion-item>
            <ion-text style="font-size: 0.9rem">
              It can ask you to approve Canton transactions and message signatures for the
              primary party. This does not connect the site to your EVM accounts. You can
              disconnect it at any time in Settings.
            </ion-text>
          </ion-item>
        </template>
        <ion-item v-else>
          <ion-text style="font-size: 0.9rem">
            The site will see your selected account address
            <b v-if="selectedAccount?.address">
              {{
                selectedAccount.address.slice(0, 6) + "..." + selectedAccount.address.slice(-4)
              }}</b
            >, your network, and can ask you to approve transactions and signatures. You can
            disconnect it at any time in Settings.
          </ion-text>
        </ion-item>
        <ion-item>Auto-reject Timer:&nbsp;<b>{{ timerReject }}</b></ion-item>
        <ion-item class="no-inner-border">
          <ion-button @click="onCancel">Cancel</ion-button>
          <ion-button @click="onConnect" :disabled="!origin || (canton && !parties.length)"
            >Connect</ion-button
          >
        </ion-item>
      </ion-list>
    </ion-content>
  </ion-page>
</template>

<script lang="ts" setup>
import { ref } from "vue";
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
  onIonViewWillEnter,
} from "@ionic/vue";
import { useRoute } from "vue-router";
import { approve, walletPing } from "@/extension/userRequest";
import { getStoredSelectedAccount, hexTostr } from "@/utils/platform";
import type { Account } from "@/extension/types";

const route = useRoute();
const rid = (route?.params?.rid as string) ?? "";

// The service worker passes { origin, subframe } taken from the browser-provided sender.
// Canton (CIP-0103) connections add { canton: true, networkId, parties }.
type SharedParty = { partyId: string; primary: boolean; name: string };
let origin = "";
let subframe = false;
let canton = false;
let networkId = "";
let parties: SharedParty[] = [];
try {
  const data = JSON.parse(hexTostr((route?.params?.param as string) ?? ""));
  origin = String(data?.origin ?? "");
  subframe = !!data?.subframe;
  canton = data?.canton === true;
  networkId = String(data?.networkId ?? "");
  parties = Array.isArray(data?.parties)
    ? data.parties.map((p: any) => ({
        partyId: String(p?.partyId ?? ""),
        primary: !!p?.primary,
        name: String(p?.name ?? ""),
      }))
    : [];
} catch {
  origin = "";
}

const selectedAccount = ref(null as Account | null);
const timerReject = ref(140);
let interval: any;

const onCancel = () => {
  if (interval) {
    clearInterval(interval);
  }
  window.close();
};

const onConnect = () => {
  if (interval) {
    clearInterval(interval);
  }
  approve(rid);
};

onIonViewWillEnter(async () => {
  getStoredSelectedAccount().then((account) => {
    selectedAccount.value = account;
  });
  interval = setInterval(async () => {
    if (timerReject.value <= 0) {
      onCancel();
      return;
    }
    timerReject.value -= 1;
    walletPing();
  }, 1000) as any;
});
</script>
