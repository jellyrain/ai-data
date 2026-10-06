<script setup lang="ts">
import { ElInput } from "element-plus";
const value = defineModel<string>({ required: true });
defineProps<{ label: string; hint?: string; disabled?: boolean; rows?: number }>();
</script>
<template>
  <div class="management-section">
    <h3>{{ label }}</h3>
    <p v-if="hint" class="management-help">{{ hint }}</p>
    <ElInput
      v-model="value"
      type="textarea"
      :rows="rows ?? 6"
      :aria-label="label"
      :disabled="disabled"
      spellcheck="false"
    />
  </div>
</template>
