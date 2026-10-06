<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { ElDialog, ElInput, ElButton } from "element-plus";
import { useServices } from "../../../app/services";
import { ReportEditor } from "../stores/report-editor";
const props = defineProps<{ reportId: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const services = useServices();
const editor = new ReportEditor({
  request: services.request,
  resources: services.resources,
  identity: () => services.auth.state.context,
});
const state = editor.state;
watch(
  () => props.reportId,
  (id) => {
    if (id) void editor.open(id);
    else editor.leave();
  },
  { immediate: true },
);
onBeforeUnmount(() => editor.dispose());
async function save() {
  if (await editor.save()) emit("saved");
}
</script>
<template>
  <ElDialog
    :model-value="!!reportId"
    title="报表名称与说明"
    width="min(520px, 94vw)"
    :close-on-click-modal="false"
    @close="emit('close')"
  >
    <p class="muted">使用便于长期查找的名称，日期和科室由筛选条件决定。</p>
    <form class="report-metadata-form" @submit.prevent="save">
      <label
        >报表名称<ElInput
          :model-value="state.draft.title"
          aria-label="报表名称"
          :maxlength="512"
          :disabled="!state.ready || state.saving || state.uncertain"
          @update:model-value="editor.update({ ...state.draft, title: String($event) })"
      /></label>
      <label
        >简短说明<ElInput
          :model-value="state.draft.description ?? ''"
          aria-label="简短说明"
          type="textarea"
          :maxlength="1000"
          :disabled="!state.ready || state.saving || state.uncertain"
          @update:model-value="editor.update({ ...state.draft, description: String($event) })"
      /></label>
      <p v-if="state.error" role="alert" class="inline-error">{{ state.error }}</p>
      <p v-for="issue in state.issues" :key="issue" role="alert">{{ issue }}</p>
      <p v-if="state.latest" role="alert">报表已被更新。请重新读取最新内容后修改名称。</p>
      <ElButton v-if="state.latest" @click="editor.open(reportId)">读取最新内容</ElButton>
      <ElButton v-if="state.uncertain" @click="editor.checkSaved()">核对保存结果</ElButton>
      <p v-if="state.notice" role="status">{{ state.notice }}</p>
      <footer class="report-heading-actions">
        <ElButton @click="emit('close')">关闭</ElButton
        ><ElButton
          native-type="submit"
          type="primary"
          :loading="state.saving"
          :disabled="!state.ready || !!state.latest || state.uncertain || !state.draft.title.trim()"
          >保存</ElButton
        >
      </footer>
    </form>
  </ElDialog>
</template>
