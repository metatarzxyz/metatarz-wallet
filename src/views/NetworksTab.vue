<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="end">
          <router-link to="/tabs/add-network">
            <ion-button>
              <ion-icon slot="icon-only" :icon="addCircleOutline"></ion-icon>
            </ion-button>
          </router-link>
        </ion-buttons>
        <ion-title>Networks</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-item
        v-if="!loading && networks.length < 1"
        class="no-inner-border"
      >
        <ion-label>No EVM Networks found</ion-label>
        <ion-button @click="goToAddNetwork">Add Network</ion-button>
      </ion-item>

      <ion-list>
        <ion-item
          class="no-inner-border"
          v-for="network of networks"
          :key="network?.chainId"
        >
          <ion-avatar
            v-if="(allTemplateNets as any)[network?.chainId]?.icon"
            style="margin-right: 1rem; width: 1.6rem; height: 1.6rem"
          >
            <img
              :alt="network?.name"
              :src="getUrl('assets/chain-icons/' + (allTemplateNets as any)[network?.chainId].icon)"
            />
          </ion-avatar>
          <ion-avatar v-else style="margin-right: 1rem; width: 1.6rem; height: 1.6rem">
            <GenericBlockChain />
          </ion-avatar>
          <div style="display: flex; flex-direction: column; max-width: 7rem">
            <ion-label style="font-size: 0.9rem">
              {{ network?.name }}
            </ion-label>
            <ion-label style="font-size: 0.82rem; opacity: 0.8">
              ID: {{ network?.chainId }}
            </ion-label>
          </div>
          <ion-item style="margin-left: auto; font-size: 0.9rem">
            <ion-chip color="primary" @click="editNetwork(network?.chainId)" button
              >Edit</ion-chip
            >
            <ion-chip color="primary" @click="deleteNetwork(network?.chainId)" button
              >Delete</ion-chip
            >
          </ion-item>
        </ion-item>
      </ion-list>
    </ion-content>
  </ion-page>
</template>

<script lang="ts" setup>
import { computed, ref, Ref } from "vue";
import { getNetworks, getUrl, replaceNetworks } from "@/utils/platform";
import {
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  IonIcon,
  IonList,
  IonItem,
  IonLabel,
  IonChip,
  IonButtons,
  IonButton,
  onIonViewWillEnter,
  IonAvatar,
} from "@ionic/vue";
import { allTemplateNets } from "@/utils/networks";
import { addCircleOutline, copyOutline } from "ionicons/icons";
import router from "@/router/index";
import type { Networks } from "@/extension/types";
import GenericBlockChain from "@/components/icons/GenericBlockChain.vue";

/** Networks as stored (keyed by chainId), the source of truth. */
const networksById = ref({}) as Ref<Networks>;
const loading = ref(true);

/** Display order: Canton first, rest in storage order. */
const networks = computed(() =>
  Object.values(networksById.value).sort((a, b) => {
    if (a.chainId === 31337) return -1;
    if (b.chainId === 31337) return 1;
    return 0;
  }),
);

const loadData = async () => {
  networksById.value = await getNetworks();
  loading.value = false;
};

const deleteNetwork = async (chainId: number) => {
  loading.value = true;
  try {
    // Re-read storage so a stale view can't overwrite newer changes.
    const current = await getNetworks();
    delete current[chainId];
    await replaceNetworks(current);
    networksById.value = current;
  } finally {
    loading.value = false;
  }
};

const editNetwork = (chainId: number) => {
  router.push(`add-network/edit/${chainId}`);
};

const goToAddNetwork = () => {
  router.push("/tabs/add-network");
};

onIonViewWillEnter(() => {
  loadData();
});
</script>
