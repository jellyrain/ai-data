<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import { ElButton } from "element-plus";
import PageState from "../shared/ui/page-state.vue";
const route = useRoute();
const router = useRouter();
</script>
<template>
  <PageState
    :title="route.name === 'forbidden' ? '暂无访问权限' : '找不到这个页面'"
    :description="
      route.name === 'forbidden'
        ? '如需访问，请联系组织管理员调整权限。'
        : '页面可能已移动，请检查地址或返回工作台。'
    "
    ><ElButton type="primary" @click="router.push('/analysis')">返回工作台</ElButton></PageState
  >
</template>
