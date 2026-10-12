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
    content.value = "";
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
  <section class="agent-skill-preview" :aria-label="`${name} 源文档预览`">
    <div class="agent-skill-preview-toolbar">
      <p class="management-help">
        这里读取当前 Skill 源库。已发布 Agent 使用其版本对应的资源快照与指纹。
      </p>
      <form class="agent-skill-document-form" @submit.prevent="read">
        <label for="agent-skill-document-path">文档路径</label>
        <div class="management-inline-row">
          <ElInput
            id="agent-skill-document-path"
            v-model="path"
            aria-label="Skill 子文档路径"
            :disabled="scope.state.busy"
            placeholder="SKILL.md 或 references/示例.md"
          /><ElButton native-type="submit" :loading="scope.state.busy">读取文档</ElButton>
        </div>
      </form>
      <ManagementFeedback v-bind="scope.state" />
    </div>
    <div class="agent-skill-preview-content" :aria-busy="scope.state.busy">
      <MarkdownContent v-if="content" :text="content" />
    </div>
  </section>
</template>
