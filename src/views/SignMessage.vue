<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>Sign Message</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-item style="margin-bottom: 6px">
        <div style="display: flex; flex-direction: column">
          <div v-if="website">
            <span style="font-size: 0.95rem; opacity: 0.9">
              Request from: <b>{{ website }}</b>
            </span>
          </div>
          <div v-if="intialSelectedAccount?.name">
            <span style="font-size: 0.95rem; opacity: 0.9"
              >Sign Message with:
              {{ "[ " + intialSelectedAccount?.name }}
              <span style="font-size: 0.8rem; opacity: 0.7">
                {{
                  " ( " +
                  intialSelectedAccount?.address.slice(0, 4) +
                  "..." +
                  intialSelectedAccount?.address.slice(-4) +
                  " ) "
                }}
              </span>
              {{ "]" }}
            </span>
          </div>
        </div>
      </ion-item>
      <ion-item v-if="signNote">
        <span style="font-size: 0.9rem; color: var(--ion-color-warning)">{{ signNote }}</span>
      </ion-item>
      <ion-item>
        <div
          style="
            white-space: pre-wrap;
            width: 100%;
            height: 250px;
            overflow-y: scroll;
            margin: 0.4rem;
          "
          disabled
        >
          {{ signMsg }}
        </div>
      </ion-item>
      <ion-item style="margin-top: 6px"
        >Auto-reject Timer:&nbsp;<b>{{ timerReject }}</b></ion-item
      >
      <ion-item style="display: flex; justify-self: end" class="no-inner-border">
        <ion-button @click="onCancel">Cancel</ion-button>
        <ion-button @click="onSign">Sign</ion-button>
      </ion-item>
      <ion-alert
        :is-open="alertOpen"
        header="Error"
        :message="alertMsg"
        :buttons="['OK']"
        @didDismiss="alertOpen = false"
      ></ion-alert>
      <ion-loading
        :is-open="loading"
        cssClass="my-custom-class"
        message="Please wait..."
        :key="`k${loading}`"
        @didDismiss="loading = false"
      />
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
  IonAlert,
  IonLoading,
  modalController,
  onIonViewWillEnter,
} from "@ionic/vue";
import { approve, walletPing } from "@/extension/userRequest";
import { useRoute } from "vue-router";
import { ethers } from "ethers";
import {
  getSelectedAccount,
  unBlockLockout,
  blockLockout,
  hexTostr,
} from "@/utils/platform";
import UnlockModal from "@/views/UnlockModal.vue";
import type { Account } from "@/extension/types";
import { setUnlockModalState } from "@/utils/unlockStore";

const route = useRoute();
const loading = ref(false);
const intialSelectedAccount = ref(null as Account | null);
const rid = (route?.params?.rid as string) ?? "";
const website = route?.params?.website ? hexTostr(route?.params?.website as string) : "";

let sigmMsg: string = "";
let sigNote: string = "";

// The service worker passes { typed, data } where data is exactly the payload that will be signed.
try {
  const { typed, data } = JSON.parse(hexTostr((route?.params?.param as string) ?? "")) as {
    typed: boolean;
    data: string;
  };
  if (typed) {
    try {
      sigmMsg = JSON.stringify(JSON.parse(data), null, 2);
    } catch {
      sigmMsg = data;
      sigNote = "Typed data is not valid JSON and cannot be signed.";
    }
  } else if (data.startsWith("0x")) {
    // Hex payloads are signed as raw bytes (see signMsg in utils/wallet.ts)
    try {
      sigmMsg = new TextDecoder("utf-8", { fatal: true }).decode(ethers.getBytes(data));
    } catch {
      sigmMsg = data;
      sigNote =
        "This message is not readable text and is shown as raw hex. It may be a hash or transaction data; only sign it if you fully trust this site.";
    }
  } else {
    sigmMsg = data;
  }
} catch {
  sigmMsg = "";
  sigNote = "Unable to decode the request.";
}

const signMsg = ref(sigmMsg);
const signNote = ref(sigNote);
const alertOpen = ref(false);
const alertMsg = ref("");
const timerReject = ref(140);
let interval: any;

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

onIonViewWillEnter(async () => {
  blockLockout();
  getSelectedAccount().then((account) => {
    intialSelectedAccount.value = account;
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

const openModal = async () => {
  const modal = await modalController.create({
    component: UnlockModal,
    animated: true,
    focusTrap: false,
    backdropDismiss: false,
    componentProps: {
      unlockType: "message",
    },
  });
  await modal.present();
  setUnlockModalState(true);
  const { role } = await modal.onWillDismiss();
  if (role === "confirm") return true;
  await setUnlockModalState(false);
  return false;
};

const onSign = async () => {
  loading.value = true;
  if (interval) {
    clearInterval(interval);
  }
  const selectedAccount = await getSelectedAccount();
  loading.value = false;
  if ((selectedAccount.pk ?? "").length !== 66) {
    const modalResult = await openModal();
    if (modalResult) {
      await unBlockLockout(true);
      loading.value = true;
      approve(rid);
    } else {
      onCancel();
    }
  } else {
    await unBlockLockout(true);
    approve(rid);
  }
  loading.value = false;
};
</script>

<style scoped>
ion-item {
  --min-height: 30px;
  --padding-start: 8px;
  --padding-end: 8px;
}
</style>
