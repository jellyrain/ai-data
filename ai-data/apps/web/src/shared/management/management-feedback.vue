<script setup lang="ts">
defineProps<{ error: string; notice: string; busy: boolean }>();
</script>
<template>
  <p v-if="error" role="alert" class="inline-error management-feedback">{{ error }}</p>
  <p v-if="notice" role="status" class="management-feedback">{{ notice }}</p>
  <span v-if="busy" role="status" class="muted management-feedback">正在处理，请稍候…</span>
</template>
