<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title v-if="existingPassword">Enter Encryption Password</ion-title>
        <ion-title v-else>Create Encryption Password</ion-title>
        <ion-buttons v-if="!required" slot="end">
          <ion-button @click="close" color="primary">Close</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-list>
        <ion-item v-if="required">
          Your private keys are stored unencrypted. Storage encryption is now mandatory:
          {{ existingPassword ? "enter your encryption password" : "set a password" }}
          to encrypt them before continuing.
        </ion-item>
        <ion-item v-else>
          A password is required to encrypt your private keys. It will be needed to
          unlock the wallet.
        </ion-item>
        <ion-item>
          <ion-label>{{ existingPassword ? "Password" : "New Password" }}</ion-label>
        </ion-item>
        <ion-item>
          <ion-input
            aria-label="password"
            type="password"
            v-model="mpPass"
            autocomplete="off"
            fill="outline"
          ></ion-input>
        </ion-item>
        <template v-if="!existingPassword">
          <ion-item>
            <ion-label>Confirm New Password</ion-label>
          </ion-item>
          <ion-item>
            <ion-input
              aria-label="confirm password"
              type="password"
              v-model="mpConfirm"
              autocomplete="off"
              fill="outline"
            ></ion-input>
          </ion-item>
        </template>
      </ion-list>
      <ion-item>
        <ion-button @click="confirm">Confirm</ion-button>
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
  IonLabel,
  IonInput,
  IonButton,
  IonAlert,
  IonList,
  IonButtons,
  IonLoading,
  modalController,
} from "@ionic/vue";
import { setupStorageEncryption } from "@/utils/storageEncryption";

// required: migration of an existing plaintext install, the modal cannot be closed.
// existingPassword: a password was set before and must be re-entered.
const props = defineProps<{
  required?: boolean;
  existingPassword?: boolean;
}>();

const mpPass = ref("");
const mpConfirm = ref("");
const loading = ref(false);
const alertOpen = ref(false);
const alertMsg = ref("");

const close = () => {
  return modalController?.dismiss(null, "cancel");
};

const showError = (msg: string) => {
  alertMsg.value = msg;
  alertOpen.value = true;
};

const confirm = async () => {
  if (mpPass.value.length < 3) {
    showError("Password is too short. More than 3 characters are required.");
    return;
  }
  if (!props.existingPassword && mpPass.value !== mpConfirm.value) {
    showError("Password and confirm password do not match");
    return;
  }
  try {
    loading.value = true;
    await setupStorageEncryption(mpPass.value);
    loading.value = false;
    const pass = mpPass.value;
    mpPass.value = "";
    mpConfirm.value = "";
    return modalController?.dismiss(pass, "confirm");
  } catch (e) {
    console.error(e);
    loading.value = false;
    showError(
      props.existingPassword
        ? "Decryption failed, password is not correct, try again."
        : "Failed to encrypt the private keys, try again."
    );
  }
};
</script>
