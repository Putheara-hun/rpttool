<script setup lang="ts">
import { ref } from 'vue';
import { LockKeyhole } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import { signIn } from '../data/dbApi';
import { state } from '../store/designer';

/** Team password of a ReportTool server on the internet (REPORTTOOL_PASSWORD): protects its database connections. */
const password = ref('');
const error = ref('');
const busy = ref(false);

const finish = (ok: boolean) => state.siteLogin?.resolve(ok);
async function submit() {
  if (!password.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await signIn(password.value);
    finish(true);
  } catch (e) {
    error.value = (e as Error).message;
    password.value = '';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal title="Sign in to use databases" :width="440" @close="finish(false)">
    <template #icon><LockKeyhole :size="16" /></template>
    <form class="col" @submit.prevent="submit">
      <span class="hint" style="font-size: 12.5px; line-height: 1.5">
        Database connections on this website are protected by a team password. Ask the person who set up ReportTool for it. You stay signed in on this browser for 7 days.
      </span>
      <input v-model="password" type="password" placeholder="Team password" autocomplete="current-password" autofocus />
      <span v-if="error" class="err">{{ error }}</span>
    </form>
    <template #footer>
      <button class="btn" @click="finish(false)">Cancel</button>
      <button class="btn primary" :disabled="busy || !password" @click="submit">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
    </template>
  </Modal>
</template>
