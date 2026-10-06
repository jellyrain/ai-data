<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, onBeforeRouteUpdate } from "vue-router";
import { ElButton } from "element-plus";
import KnowledgeBoard from "../components/knowledge-board.vue";
import PreferencesPanel from "../../preferences/components/preferences-panel.vue";
const route = useRoute();
const admin = computed(() => route.path === "/settings/knowledge");
const tab = ref<"published" | "preferences" | "candidates" | "assigned" | "management">(
  admin.value || route.query.tab === "candidates" ? "candidates" : "published",
);
onBeforeRouteUpdate(async () => (child.value ? child.value.discard() : true));
watch(admin, (value) => {
  tab.value = value ? "candidates" : "published";
});
const child = ref<{ discard(): Promise<boolean>; busy: boolean }>();
const tabs = computed(() =>
  admin.value
    ? ([
        { id: "candidates", label: "组织候选" },
        { id: "management", label: "正式知识管理" },
      ] as const)
    : ([
        { id: "published", label: "企业知识" },
        { id: "preferences", label: "个人偏好" },
        { id: "candidates", label: "我的候选" },
        { id: "assigned", label: "待我审核" },
        { id: "management", label: "我负责的知识" },
      ] as const),
);
async function select(value: typeof tab.value) {
  if (child.value && !(await child.value.discard())) return;
  tab.value = value;
}
</script>
<template>
  <section class="management-page knowledge-page">
    <header class="management-heading">
      <div>
        <h1>{{ admin ? "知识审核" : "知识与偏好" }}</h1>
        <p class="muted">
          {{
            admin
              ? "分配负责人，审核固定版本，管理正式知识的生效状态。"
              : "查看业务口径，管理分析习惯，参与知识积累。"
          }}
        </p>
      </div>
    </header>
    <nav class="knowledge-tabs" aria-label="知识分类">
      <ElButton
        v-for="item in tabs"
        :key="item.id"
        :type="tab === item.id ? 'primary' : 'default'"
        :aria-pressed="tab === item.id"
        :disabled="child?.busy"
        @click="select(item.id)"
        >{{ item.label }}</ElButton
      >
    </nav>
    <PreferencesPanel v-if="tab === 'preferences'" ref="child" /><KnowledgeBoard
      v-else
      :key="tab + ':' + admin"
      ref="child"
      :mode="tab"
      :admin="admin"
    />
  </section>
</template>
