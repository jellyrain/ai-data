<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElConfigProvider, ElButton } from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { useServices } from "./app/services";
import AppLayout from "./app/app-layout.vue";
import PageState from "./shared/ui/page-state.vue";
import { safeReturnPath } from "./app/router";
import { navigation, canAccess } from "./app/navigation";

const { auth } = useServices();
const router = useRouter();
const route = useRoute();
const busy = computed(() => ["idle", "restoring", "logging-out"].includes(auth.state.status));
const failure = computed(() => ["error", "logout-error"].includes(auth.state.status));
async function retry() {
  if (auth.state.status === "logout-error") await auth.logout().catch(() => {});
  else await auth.restore();
}
watch(
  () => auth.state.status,
  async (status) => {
    // 初次导航由守卫完成；此处仅协调页面打开后的身份变化。
    await router.isReady();
    if (status !== auth.state.status) return;
    if (status === "anonymous" && route.name !== "login")
      await router.replace({ name: "login", query: { returnTo: route.fullPath } });
    if (status === "authenticated") {
      if (route.name === "login")
        await router.replace(safeReturnPath(route.query.returnTo, router));
      else {
        const item = navigation.find((entry) => entry === route.meta.item);
        if (item && !canAccess(item, auth.state.context)) await router.replace("/forbidden");
      }
    }
  },
);
</script>

<template>
  <ElConfigProvider :locale="zhCn">
    <div v-if="busy || failure" class="full-page-state">
      <PageState
        :title="
          busy
            ? auth.state.status === 'logging-out'
              ? '正在安全退出'
              : '正在恢复登录状态'
            : auth.state.status === 'logout-error'
              ? '退出尚未完成'
              : '暂时无法连接服务'
        "
        :description="busy ? '请稍候…' : auth.state.error?.message"
        :busy="busy"
      >
        <p v-if="auth.state.error?.requestId" class="request-id">
          请求编号：{{ auth.state.error.requestId }}
        </p>
        <ElButton v-if="failure" type="primary" @click="retry">重试</ElButton>
      </PageState>
    </div>
    <AppLayout v-else-if="auth.state.status === 'authenticated' && route.name !== 'login'" />
    <RouterView v-else-if="route.name === 'login'" />
    <PageState v-else title="正在打开页面" busy />
  </ElConfigProvider>
</template>
