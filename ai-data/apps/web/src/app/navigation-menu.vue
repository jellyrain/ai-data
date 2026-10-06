<script setup lang="ts">
import { computed, type Component } from "vue";
import { useRoute } from "vue-router";
import {
  ChartNoAxesCombined,
  FileChartColumn,
  BookOpen,
  Settings2,
  Box,
  Bot,
  Users,
  ShieldCheck,
  Database,
  BookCheck,
  Clock3,
} from "lucide-vue-next";
import { navigation, canAccess } from "./navigation";
import { useServices } from "./services";
const emit = defineEmits<{ navigate: [] }>();
const { auth } = useServices();
const route = useRoute();
/** 导航图标对应业务模块，共用线性图标体系。 */
const icons: Record<string, Component> = {
  "/analysis": ChartNoAxesCombined,
  "/reports": FileChartColumn,
  "/knowledge": BookOpen,
  "/settings/models": Box,
  "/settings/agents": Bot,
  "/settings/users": Users,
  "/settings/permissions": ShieldCheck,
  "/settings/data": Database,
  "/settings/knowledge": BookCheck,
  "/settings/tasks": Clock3,
};
const groups = computed(() =>
  [...new Set(navigation.map((item) => item.group))]
    .map((name) => ({
      name,
      items: navigation.filter(
        (item) => item.group === name && canAccess(item, auth.state.context),
      ),
    }))
    .filter((group) => group.items.length),
);
</script>
<template>
  <nav aria-label="主导航" class="navigation-menu">
    <section v-for="group in groups" :key="group.name">
      <h2>{{ group.name }}</h2>
      <RouterLink
        v-for="item in group.items"
        :key="item.path"
        :to="item.path"
        :class="{ selected: route.path === item.path || route.path.startsWith(item.path + '/') }"
        :aria-current="
          route.path === item.path || route.path.startsWith(item.path + '/') ? 'page' : undefined
        "
        @click="emit('navigate')"
        ><component :is="icons[item.path] ?? Settings2" :size="17" aria-hidden="true" /><span>{{
          item.title
        }}</span></RouterLink
      >
    </section>
  </nav>
</template>
