<script setup lang="ts">
import { computed } from 'vue';
import ConnectionDialog from './ConnectionDialog.vue';
import { state } from '../store/designer';

/** "Connect to database": a report's connection is missing (e.g. after a restart) or its login was refused. */
const req = computed(() => state.reconnectRequests[0] ?? null);
</script>

<template>
  <ConnectionDialog
    v-if="req"
    :key="req.key"
    :connection="req.connection"
    :reconnect="{ reason: req.reason, dataSource: req.dataSource }"
    @saved="(c) => req!.resolve(c)"
    @close="req!.resolve(null)"
  />
</template>
