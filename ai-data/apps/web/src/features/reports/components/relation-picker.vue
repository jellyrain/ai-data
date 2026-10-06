<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElSelect, ElOption } from "element-plus";
import type { CatalogRelation } from "@ai-data/contracts";
import type { ReportEditor } from "../stores/report-editor";
import { cloneDefinition } from "../models/definition-editor";
import { connectRelation } from "../models/query-editing";
const props = defineProps<{
  editor: ReportEditor;
  queryId: string;
  sourceAlias: string;
  targetAlias?: string;
}>();
const emit = defineEmits<{ connected: [alias: string]; close: [] }>();
const loading = ref(false),
  error = ref(""),
  selected = ref(""),
  type = ref<"inner" | "left" | "right">("left");
const query = computed(
  () => props.editor.state.draft.queries.find((q) => q.query_id === props.queryId)?.query,
);
const source = computed(() =>
  query.value?.type === "relational_query"
    ? [query.value.from, ...query.value.joins].find((o) => o.alias === props.sourceAlias)
    : undefined,
);
const graph = computed(() =>
  query.value?.type === "relational_query" && source.value
    ? props.editor.state.relations[JSON.stringify([query.value.source_id, source.value.object_id])]
    : undefined,
);
const relations = computed(
  () =>
    graph.value?.outgoing.filter((r) => {
      const q = query.value;
      if (!q || q.type !== "relational_query") return false;
      return (
        !props.targetAlias ||
        q.joins.some((j) => j.alias === props.targetAlias && j.object_id === r.target_object_id)
      );
    }) ?? [],
);
const relation = computed(() => relations.value.find((r) => r.relation_id === selected.value));
watch(
  () => [props.queryId, props.sourceAlias, props.targetAlias],
  async () => {
    selected.value = "";
    error.value = "";
    const q = query.value,
      object = source.value;
    if (!q || q.type !== "relational_query" || !object) return;
    loading.value = true;
    await props.editor.loadRelations(q.source_id, object.object_id);
    loading.value = false;
  },
  { immediate: true },
);
function choose(value: CatalogRelation) {
  selected.value = value.relation_id;
  type.value = value.allowed_join_types.includes("left") ? "left" : value.allowed_join_types[0]!;
}
function connect() {
  if (!relation.value) return;
  try {
    const definition = cloneDefinition(props.editor.state.draft),
      item = definition.queries.find((q) => q.query_id === props.queryId);
    if (!item || item.query.type !== "relational_query") return;
    item.query = connectRelation(
      item.query,
      props.sourceAlias,
      relation.value,
      type.value,
      props.targetAlias,
    );
    props.editor.update(definition);
    emit("connected", props.targetAlias ?? item.query.joins.at(-1)!.alias);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>
<template>
  <section class="relation-picker">
    <header class="editor-record-heading">
      <strong>{{ sourceAlias }} → {{ targetAlias || "关联对象" }}</strong
      ><ElButton text aria-label="关闭关联菜单" @click="emit('close')">关闭</ElButton>
    </header>
    <p class="muted">选择批准的业务关系</p>
    <p v-if="loading" role="status">正在读取关系…</p>
    <p v-if="error || editor.state.catalogError" role="alert" class="inline-error">
      {{ error || editor.state.catalogError }}
    </p>
    <div class="relation-options">
      <button
        v-for="item in relations"
        :key="item.relation_id"
        type="button"
        class="relation-option"
        :class="{ selected: selected === item.relation_id }"
        @click="choose(item)"
      >
        <strong>{{ item.description }}</strong
        ><span>{{ item.target_object_id }}</span
        ><small
          v-for="pair in item.column_pairs"
          :key="`${pair.source_column}:${pair.target_column}`"
          >{{ pair.source_column }} → {{ pair.target_column }}</small
        >
      </button>
    </div>
    <p v-if="!loading && !relations.length" class="muted">当前对象之间没有可执行的批准关系。</p>
    <template v-if="relation"
      ><label
        >连接方式<ElSelect v-model="type" aria-label="连接方式"
          ><ElOption
            v-for="join in relation.allowed_join_types"
            :key="join"
            :value="join"
            :label="
              join === 'left'
                ? '左连接 · 保留起点'
                : join === 'right'
                  ? '右连接 · 保留终点'
                  : '内连接 · 匹配记录'
            " /></ElSelect></label
      ><ElButton type="primary" class="relation-connect" @click="connect">{{
        targetAlias ? "更新关联" : "添加关联对象"
      }}</ElButton></template
    >
    <details v-if="graph?.incoming.length">
      <summary>入向关系 · {{ graph.incoming.length }}</summary>
      <p
        v-for="item in graph.incoming"
        :key="`${item.object_id}:${item.relation_id}`"
        class="muted"
      >
        {{ item.object_id }} → {{ item.description }}
      </p>
    </details>
  </section>
</template>
