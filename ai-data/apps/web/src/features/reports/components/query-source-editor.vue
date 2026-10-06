<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElSelect, ElOption, ElMessageBox } from "element-plus";
import type { ReportEditor } from "../stores/report-editor";
import { replacePrimary } from "../models/query-editing";
const props = defineProps<{ editor: ReportEditor; queryId: string }>();
const source = ref(""),
  object = ref("");
const query = computed(
  () => props.editor.state.draft.queries.find((q) => q.query_id === props.queryId)?.query,
);
watch(
  () => {
    const q = query.value;
    return [
      props.queryId,
      q?.type,
      q && q.type !== "metric_query" ? q.source_id : "",
      q && q.type !== "metric_query" ? q.from.object_id : "",
    ];
  },
  () => {
    const q = query.value;
    if (q && q.type !== "metric_query") {
      source.value = q.source_id;
      object.value = q.from.object_id;
    }
  },
  { immediate: true },
);
watch(source, (value) => {
  void props.editor.loadDatasets(value);
});
async function replace() {
  const dataset = props.editor.state.datasets[source.value]?.find(
      (d) => d.object_id === object.value,
    ),
    q = query.value;
  if (!dataset || !q || q.type === "metric_query") return;
  if (q.source_id === dataset.source_id && q.from.object_id === dataset.object_id) return;
  const item = props.editor.state.draft.queries.find((q) => q.query_id === props.queryId)!;
  try {
    await ElMessageBox.confirm(
      `更换为 ${dataset.object_id}？将重建输出字段，移除 ${q.type === "relational_query" ? q.joins.length : 0} 条关联、现有筛选和 ${item.bindings.length} 处参数绑定，并重新匹配展示字段。`,
      "更换查询主对象",
      { confirmButtonText: "更换对象", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  props.editor.update(replacePrimary(props.editor.state.draft, props.queryId, dataset));
}
</script>
<template>
  <details class="query-source-editor">
    <summary>更换数据源与主对象</summary>
    <label
      >数据源<ElSelect
        v-model="source"
        aria-label="更换查询数据源"
        @visible-change="$event && editor.loadSources()"
        ><ElOption
          v-for="item in editor.state.sources"
          :key="item.source_id"
          :value="item.source_id"
          :label="item.source_id" /></ElSelect></label
    ><ElButton v-if="editor.state.sourceCursor" text @click="editor.loadSources(true)"
      >加载更多数据源</ElButton
    ><label
      >主对象<ElSelect v-model="object" filterable aria-label="更换查询主对象"
        ><ElOption
          v-for="item in editor.state.datasets[source] ?? []"
          :key="item.object_id"
          :value="item.object_id"
          :label="item.name" /></ElSelect></label
    ><ElButton @click="replace">更换对象</ElButton>
  </details>
</template>
