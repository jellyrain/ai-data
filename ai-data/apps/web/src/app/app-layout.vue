<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import { useRoute } from "vue-router";
import { ElButton, ElDrawer } from "element-plus";
import { ChartNoAxesCombined, Menu, LogOut } from "lucide-vue-next";
import { useServices } from "./services";
import { useLayoutStore } from "./layout-store";
import { navigation } from "./navigation";
import NavigationMenu from "./navigation-menu.vue";
import AppearancePicker from "../shared/ui/appearance-picker.vue";
import AccountFooter from "./account-footer.vue";
const { auth, resources } = useServices();
const layout = useLayoutStore();
const route = useRoute();
const title = computed(
  () => navigation.find((item) => item === route.meta.item)?.title ?? "工作空间",
);
const unregister = resources.register(() => layout.$reset());
onUnmounted(unregister);
watch(
  () => route.fullPath,
  () => {
    layout.navigationOpen = false;
  },
);
async function logout() {
  await auth.logout().catch(() => {});
}
</script>
<template>
  <div class="app-layout" :class="{ 'canvas-layout': layout.canvas }">
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <aside class="desktop-sidebar">
      <RouterLink to="/analysis" class="brand"
        ><span class="brand-mark"><ChartNoAxesCombined :size="22" aria-hidden="true" /></span>AI
        Data</RouterLink
      ><NavigationMenu />
      <AccountFooter :display-name="auth.state.user?.displayName" />
    </aside>
    <ElDrawer v-model="layout.navigationOpen" title="工作空间导航" direction="ltr" size="280px">
      <NavigationMenu @navigate="layout.navigationOpen = false" />
      <template #footer><AccountFooter :display-name="auth.state.user?.displayName" /></template>
    </ElDrawer>
    <div class="workspace">
      <header class="app-header">
        <div class="header-context">
          <ElButton class="mobile-menu" aria-label="打开导航" @click="layout.navigationOpen = true"
            ><Menu :size="18" aria-hidden="true" /></ElButton
          ><span class="breadcrumb-root">工作空间</span
          ><span class="breadcrumb-separator" aria-hidden="true">/</span><span>{{ title }}</span>
        </div>
        <div class="header-actions">
          <AppearancePicker /><span class="user-display" :title="auth.state.user?.displayName">{{
            auth.state.user?.displayName
          }}</span
          ><ElButton aria-label="退出登录" @click="logout"
            ><LogOut :size="16" aria-hidden="true" /><span class="logout-label"
              >退出</span
            ></ElButton
          >
        </div>
      </header>
      <main
        id="main-content"
        class="workspace-content"
        :class="{
          'analysis-content': route.path === '/analysis' || route.path.startsWith('/analysis/'),
        }"
        tabindex="-1"
      >
        <RouterView />
      </main>
    </div>
  </div>
</template>
