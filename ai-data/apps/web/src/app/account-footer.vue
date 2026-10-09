<script setup lang="ts">
import { ref } from "vue";
import { ElPopover } from "element-plus";
import { LockKeyhole, Monitor, ShieldAlert } from "lucide-vue-next";
import { connectionContext } from "../shared/security/connection-context";

defineProps<{ displayName?: string }>();
const connection = connectionContext(location.protocol, window.isSecureContext, location.hostname);
const icon =
  connection.kind === "secure" ? LockKeyhole : connection.kind === "local" ? Monitor : ShieldAlert;
const opened = ref(false);
</script>
<template>
  <div class="sidebar-footer">
    <span class="account-avatar" aria-hidden="true">{{ displayName?.slice(0, 1) || "A" }}</span>
    <div>
      <strong :title="displayName">{{ displayName }}</strong>
      <ElPopover
        v-model:visible="opened"
        trigger="click"
        role="dialog"
        aria-label="连接环境"
        placement="top-start"
        :width="264"
      >
        <template #reference>
          <button
            type="button"
            class="connection-status"
            :class="`connection-${connection.kind}`"
            :aria-label="`连接环境：${connection.label}`"
            :aria-expanded="opened"
            @keydown.esc.stop="opened = false"
          >
            <component :is="icon" :size="13" aria-hidden="true" />
            <span>{{ connection.label }}</span>
          </button>
        </template>
        <section class="connection-explanation" aria-label="连接环境说明">
          <strong>{{ connection.label }}</strong>
          <p>{{ connection.description }}</p>
        </section>
      </ElPopover>
    </div>
  </div>
</template>
