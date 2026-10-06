<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { navigation } from "./navigation";
import PageState from "../shared/ui/page-state.vue";
const route = useRoute();
const item = computed(() => navigation.find((entry) => entry === route.meta.item) ?? navigation[0]);
</script>
<template>
  <section class="module-page">
    <header class="page-heading">
      <p class="eyebrow">{{ item.group }}</p>
      <h1>{{ item.title }}</h1>
      <p>{{ item.description }}</p>
    </header>
    <div class="module-surface">
      <PageState title="功能正在准备中" description="此模块开放后，你可以在这里开始工作。" />
    </div>
  </section>
</template>
