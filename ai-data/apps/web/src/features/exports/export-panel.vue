<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElDrawer,
  ElRadioGroup,
  ElRadio,
  ElOption,
  ElSelect,
} from "element-plus";
import { Download } from "lucide-vue-next";
import { useServices } from "../../app/services";
import { ExportController } from "./export-controller";
import type { ExportJob, ExportSource } from "./export-types";
const props = defineProps<{ source: ExportSource | null; disabled?: boolean; label?: string }>();
const services = useServices();
const exporter = new ExportController({
  request: services.request,
  resources: services.resources,
  identity: () => services.auth.state.context,
});
const state = exporter.state,
  opened = ref(false),
  format = ref<ExportJob["format"]>("xlsx"),
  summaryRows = ref<50 | 100 | 200>(100),
  selected = ref<string[]>([]);
const selectedTables = computed(
  () =>
    state.document?.tables.filter((table) => table.complete && selected.value.includes(table.id)) ??
    [],
);
const rowCount = computed(() =>
  selectedTables.value.reduce((sum, table) => sum + table.result.rows.length, 0),
);
const summaryCount = computed(() =>
  selectedTables.value.reduce(
    (sum, table) => sum + Math.min(summaryRows.value, table.result.rows.length),
    0,
  ),
);
async function open() {
  if (!props.source || props.disabled) return;
  opened.value = true;
  await exporter.open(props.source);
  selected.value =
    state.document?.tables.filter((table) => table.complete).map((table) => table.id) ?? [];
}
function select(id: string, value: boolean) {
  selected.value = selected.value.filter((item) => item !== id);
  if (value) selected.value.push(id);
}
watch(
  () => JSON.stringify(props.source),
  () => {
    opened.value = false;
    exporter.leave();
    selected.value = [];
  },
);
watch(
  () => props.disabled,
  (value) => {
    if (value) {
      opened.value = false;
      exporter.leave();
    }
  },
);
watch(
  [format, summaryRows, selected],
  () => {
    if (state.ready) exporter.cancel();
  },
  { deep: true },
);
onBeforeUnmount(() => exporter.dispose());
</script>
<template>
  <ElButton :disabled="!source || disabled" @click="open"
    ><Download :size="16" />{{ label || "导出" }}</ElButton
  >
  <ElDrawer v-model="opened" title="导出文件" size="min(520px, 100vw)" @closed="exporter.leave()">
    <div class="export-options">
      <ElAlert v-if="state.error" :title="state.error" type="error" :closable="false" />
      <p v-if="state.stage" class="muted" role="status">{{ state.stage }}</p>
      <ElButton v-if="!state.document && !state.busy" @click="open">重新读取内容</ElButton>
      <template v-if="state.document">
        <strong>{{ state.document.title }}</strong>
        <label for="export-format">文件格式</label>
        <ElRadioGroup
          id="export-format"
          v-model="format"
          :disabled="state.busy"
          aria-label="文件格式"
          class="export-format-options"
          ><ElRadio value="xlsx" border>Excel · 全部完整数据</ElRadio
          ><ElRadio value="docx" border>Word · 可编辑分析文档</ElRadio
          ><ElRadio value="pdf" border>PDF · 分页分析文档</ElRadio></ElRadioGroup
        >
        <p class="muted">选择要包含的数据表。截断结果无法作为完整明细导出。</p>
        <div class="export-tables">
          <ElCheckbox
            v-for="table in state.document.tables"
            :key="table.id"
            :model-value="selected.includes(table.id)"
            :disabled="state.busy || !table.complete"
            @change="select(table.id, Boolean($event))"
          >
            <span>{{ table.title }}</span
            ><small class="muted"
              >{{ table.result.columns.length }} 列 ·
              {{ table.result.rows.length.toLocaleString() }} 行 ·
              {{ table.complete ? "完整" : "已截断，排除明细" }}</small
            >
          </ElCheckbox>
          <p v-if="!state.document.tables.length" class="muted">本次内容只有文字说明。</p>
        </div>
        <template v-if="format !== 'xlsx'">
          <label for="export-summary">每张表的摘要行数</label>
          <ElSelect
            id="export-summary"
            v-model="summaryRows"
            :disabled="state.busy"
            aria-label="每张表的摘要行数"
            ><ElOption
              v-for="value in [50, 100, 200]"
              :key="value"
              :value="value"
              :label="`${value} 行`"
          /></ElSelect>
          <p class="muted">
            文档包含正文、图表和表格摘要，当前共 {{ summaryCount.toLocaleString() }} 行，上限 2,000
            行。宽表按列分组，完整明细使用 Excel。
          </p>
        </template>
        <p role="status">
          已选 {{ selectedTables.length }} 张表 · {{ rowCount.toLocaleString() }} 行
        </p>
        <details class="export-provenance">
          <summary>查看来源与完整性</summary>
          <p v-for="(line, index) in state.document.metadata" :key="index">{{ line }}</p>
        </details>
        <div class="export-actions">
          <ElButton v-if="state.busy" @click="exporter.cancel()">取消导出</ElButton>
          <ElButton
            v-else
            type="primary"
            :disabled="
              (format === 'xlsx' && !selectedTables.length) ||
              (format !== 'xlsx' && summaryCount > 2000)
            "
            @click="exporter.generate(format, selected, summaryRows)"
            >{{ state.ready ? "重新生成" : "生成文件" }}</ElButton
          >
          <ElButton v-if="state.ready" :loading="state.busy" @click="exporter.download()"
            >下载文件</ElButton
          >
        </div>
      </template>
    </div>
  </ElDrawer>
</template>
<style scoped>
.export-options {
  display: grid;
  gap: 16px;
}
.export-options p {
  margin: 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.export-tables {
  display: grid;
  gap: 10px;
}
.export-tables :deep(.el-checkbox) {
  height: auto;
  min-height: 44px;
  margin: 0;
}
.export-tables :deep(.el-checkbox__label) {
  white-space: normal;
  overflow-wrap: anywhere;
}
.export-tables small {
  display: block;
  margin-top: 4px;
}
.export-provenance {
  font-size: 12px;
}
.export-provenance summary {
  cursor: pointer;
  margin-bottom: 12px;
}
.export-provenance p {
  margin-bottom: 8px;
}
.export-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.export-actions :deep(.el-button) {
  margin: 0;
}
</style>
