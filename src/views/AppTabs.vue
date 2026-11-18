<template>
  <ion-page>
    <ion-content>
      <ion-tabs @ionTabsWillChange="beforeTabChange" @ionTabsDidChange="afterTabChange">
        <ion-router-outlet aria-label="Tab content" />
        <ion-tab-bar
          slot="bottom"
          style="
            display: flex;
            flex-direction: column;
            height: 116px;
            box-shadow: -3px -1px #7e7e7e80;
          "
        >
          <div style="display: flex">
            <ion-tab-button tab="home" href="/tabs/home">
              <ion-icon :icon="walletOutline"></ion-icon>
              <ion-label>Wallet</ion-label>
            </ion-tab-button>

            <ion-tab-button tab="accounts" href="/tabs/accounts">
              <ion-icon :icon="personCircle"></ion-icon>
              <ion-label>Accounts</ion-label>
            </ion-tab-button>

            <ion-tab-button tab="networks" href="/tabs/networks">
              <ion-icon :icon="gitNetworkOutline"></ion-icon>
              <ion-label>Networks</ion-label>
            </ion-tab-button>

            <ion-tab-button tab="history" href="/tabs/history">
              <ion-icon :icon="receiptOutline"></ion-icon>
              <ion-label>History</ion-label>
            </ion-tab-button>

            <ion-tab-button tab="assets" href="/tabs/assets">
              <ion-icon :icon="diamondOutline"></ion-icon>
              <ion-label>Assets</ion-label>
            </ion-tab-button>
          </div>

          <div style="display: flex">
            <ion-tab-button tab="settings" href="/tabs/settings">
              <ion-icon :icon="cogOutline"></ion-icon>
              <ion-label>Settings</ion-label>
            </ion-tab-button>

            <ion-tab-button tab="send-token" href="/tabs/send-token">
              <ion-icon :icon="sendOutline"></ion-icon>
              <ion-label>Send Tokens</ion-label>
            </ion-tab-button>

            <ion-tab-button tab="manage-token" href="/tabs/manage-token">
              <ion-icon :icon="contractOutline"></ion-icon>
              <ion-label>Manage Tokens</ion-label>
            </ion-tab-button>

            <ion-tab-button tab="walletconnect" href="/tabs/walletconnect">
              <ion-icon :icon="linkOutline"></ion-icon>
              <ion-label>WalletConnect</ion-label>
            </ion-tab-button>

            <!-- <ion-tab-button tab="deposit-token" href="/tabs/deposit-token">
              <ion-icon :icon="glassesOutline"></ion-icon>
              <ion-label>Deposit Tokens</ion-label>
            </ion-tab-button> -->

            <!-- <ion-tab-button tab="write-contract" href="/tabs/write-contract">
              <ion-icon :icon="pushOutline"></ion-icon>
              <ion-label>Write Contracts</ion-label>
            </ion-tab-button> -->
          </div>
        </ion-tab-bar>
      </ion-tabs>
    </ion-content>
  </ion-page>
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted } from "vue";
import {
  modalController,
  IonPage,
  IonContent,
  IonRouterOutlet,
  IonTabs,
  IonTabBar,
  IonTabButton,
  IonLabel,
  IonIcon,
} from "@ionic/vue";
import {
  personCircle,
  walletOutline,
  diamondOutline,
  cogOutline,
  receiptOutline,
  gitNetworkOutline,
  sendOutline,
  glassesOutline,
  pushOutline,
  contractOutline,
  linkOutline
} from "ionicons/icons";

import UnlockModal from "@/views/UnlockModal.vue";
import { setUnlockModalState } from "@/utils/unlockStore";
import { CIP103_UNLOCK_WAITING_KEY, isWalletLocked } from "@/utils/platform";

// Ask for the password when the wallet window opens locked, and when a connected
// Canton site's read is blocked while this window is open. Never more than one
// prompt at a time; closing it keeps the wallet locked.
let unlockPromptOpen = false;

const latestWaitingSite = (waiting: Record<string, { label: string; at: number }> | undefined) =>
  Object.values(waiting ?? {}).sort((a, b) => b.at - a.at)[0]?.label;

const promptUnlock = async (requester?: string) => {
  if (unlockPromptOpen || !(await isWalletLocked())) return;
  if (await modalController.getTop()) return; // another dialog (e.g. a flow's own unlock) is open
  unlockPromptOpen = true;
  try {
    // The lock screen has no Close button; if it is dismissed any other way
    // (e.g. the Escape key) while the wallet is still locked, show it again.
    do {
      const modal = await modalController.create({
        component: UnlockModal,
        animated: true,
        focusTrap: false,
        backdropDismiss: false,
        keyboardClose: false,
        canDismiss: async (_data?: unknown, role?: string) => role === "confirm" || !(await isWalletLocked()),
        componentProps: requester ? { unlockType: "canton", requester } : { unlockType: "open" },
      });
      await modal.present();
      setUnlockModalState(true);
      await modal.onWillDismiss();
      await setUnlockModalState(false);
    } while (await isWalletLocked());
  } finally {
    unlockPromptOpen = false;
  }
};

const onSessionChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
  if (area !== "session" || !(CIP103_UNLOCK_WAITING_KEY in changes)) return;
  const before = changes[CIP103_UNLOCK_WAITING_KEY].oldValue ?? {};
  const after = changes[CIP103_UNLOCK_WAITING_KEY].newValue ?? {};
  // Only react to a newly recorded (or re-recorded) blocked site
  const fresh = Object.entries(after as Record<string, { label: string; at: number }>)
    .filter(([origin, v]) => (before as Record<string, { at: number }>)[origin]?.at !== v.at)
    .map(([, v]) => v.label);
  if (fresh.length) promptUnlock(fresh[0]);
};

onMounted(async () => {
  chrome.storage.onChanged.addListener(onSessionChange);
  const waiting = (await chrome.storage.session.get(CIP103_UNLOCK_WAITING_KEY))?.[CIP103_UNLOCK_WAITING_KEY];
  promptUnlock(latestWaitingSite(waiting));
});

onUnmounted(() => {
  chrome.storage.onChanged.removeListener(onSessionChange);
});

const beforeTabChange = () => {
  // do something before tab change
};
const afterTabChange = () => {
  // do something after tab change
};
</script>
