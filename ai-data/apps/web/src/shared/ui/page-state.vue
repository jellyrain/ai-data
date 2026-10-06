<script setup lang="ts">
import { Compass, LoaderCircle } from "lucide-vue-next";
defineProps<{ title: string; description?: string; busy?: boolean }>();
</script>
<template>
  <section class="page-state" :aria-busy="busy || undefined" role="status" aria-live="polite">
    <div class="state-symbol">
      <LoaderCircle v-if="busy" class="spin" :size="28" aria-hidden="true" /><Compass
        v-else
        :size="28"
        aria-hidden="true"
      />
    </div>
    <h2>{{ title }}</h2>
    <p v-if="description">{{ description }}</p>
    <slot />
  </section>
</template>
