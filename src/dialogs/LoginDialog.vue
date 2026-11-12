<script setup lang="ts">
import { computed, ref } from 'vue';
import { KeyRound } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import { loginConnection } from '../data/dbApi';
import { state } from '../store/designer';

const req = computed(() => state.loginRequests[0]);
const password = ref('');
const error = ref('');
const busy = ref(false);

function finish(ok: boolean) {
  const r = state.loginRequests.shift();
  r?.resolve(ok);
}
async function submit() {
  if (!req.value) return;
  busy.value = true;
  error.value = '';
  try {
    await loginConnection(req.value.connectionId, password.value);
    finish(true);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-if="req" :title="'Log in to ' + (req.name || 'database')" :width="420" @close="finish(false)">
    <template #icon><KeyRound :size="16" /></template>
    <form class="col" @submit.prevent="submit">
      <span class="hint">This report reads data from the database connection <b>{{ req.name }}</b>. Enter its password to continue.</span>
      <input v-model="password" type="password" placeholder="Password" autocomplete="current-password" autofocus />
      <span v-if="error" class="err">{{ error }}</span>
    </form>
    <template #footer>
      <button class="btn" @click="finish(false)">Cancel</button>
      <button class="btn primary" :disabled="busy" @click="submit">{{ busy ? 'Connecting…' : 'Log in' }}</button>
    </template>
  </Modal>
</template>
