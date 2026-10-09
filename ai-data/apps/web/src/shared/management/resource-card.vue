<script setup lang="ts">
import { ArrowUpRight } from "lucide-vue-next";
defineProps<{
  title: string;
  identifier: string;
  status: string;
  active?: boolean;
  disabled?: boolean;
}>();
defineEmits<{ select: [] }>();
</script>
<template>
  <button
    class="management-card"
    :disabled="disabled"
    :aria-label="`${title} ${identifier} ${status}`"
    @click="$emit('select')"
  >
    <span class="management-card-top"
      ><span class="management-card-icon"><slot name="icon" /></span
      ><span class="management-badge" :class="{ 'is-active': active }">{{ status }}</span></span
    >
    <strong class="management-card-title">{{ title }}</strong>
    <span class="management-card-id">{{ identifier }}</span>
    <span class="management-card-facts"><slot /></span>
    <span class="management-card-footer"
      >查看配置 <ArrowUpRight :size="16" aria-hidden="true"
    /></span>
  </button>
</template>
