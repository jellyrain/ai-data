<script setup lang="ts">
import { ref, watch } from "vue";
import { ElButton, ElInput } from "element-plus";
import { AgentApi } from "../api/agent-api";
import { useManagementPage } from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import MarkdownContent from "../../../shared/content/markdown-content.vue";
const props = defineProps<{ name: string }>();
const path = ref("SKILL.md"),
  content = ref("");
const { scope } = useManagementPage(
  () => {
    path.value = "SKILL.md";
    content.value = "";
  },
  () => false,
);
function read() {
  return scope.run(async (request) => {
    const result = await new AgentApi(request).document(props.name, path.value);
    content.value = result.content;
  });
}
watch(
  () => props.name,
  () => {
    scope.clear();
    void read();
  },
  { immediate: true },
);
</script>
<template>
  <section class="management-section">
    <h3>{{ name }} · 当前源文档</h3>
    <p class="management-help">
      这里读取当前 Skill 源库。已发布 Agent 使用其版本对应的资源快照与指纹。
    </p>
    <div class="management-inline-row">
      <ElInput
        v-model="path"
        aria-label="Skill 子文档路径"
        placeholder="SKILL.md 或 references/示例.md"
      /><ElButton :loading="scope.state.busy" @click="read">读取文档</ElButton>
    </div>
    <ManagementFeedback v-bind="scope.state" /><MarkdownContent v-if="content" :text="content" />
  </section>
</template>
