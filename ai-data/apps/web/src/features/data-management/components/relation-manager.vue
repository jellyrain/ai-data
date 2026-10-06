<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElButton, ElForm, ElFormItem, ElInput, ElSelect, ElOption } from "element-plus";
import {
  publishedRelationInputSchema,
  relationPublishInputSchema,
  stableStringify,
  type PublishedRelationInput,
  type CatalogRelation,
  type RelationGraph,
  type Dataset,
  type RelationPublishInput,
} from "@ai-data/contracts";
import { CatalogApi } from "../api/catalog-api";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import RelationsGraph from "./relations-graph.vue";
import { ApiError } from "../../../shared/http/api-error";
const props = defineProps<{
  sourceId: string;
  objectId: string;
  datasets: Dataset[];
  disabled: boolean;
}>();
const emit = defineEmits<{ published: [] }>();
const empty = (): PublishedRelationInput => ({
  relation_id: "",
  target_object_id: "",
  description: "",
  column_pairs: [{ source_column: "", target_column: "" }],
  allowed_join_types: ["inner"],
});
const graph = ref<RelationGraph | null>(null),
  draft = ref(empty()),
  origin = ref<CatalogRelation | null>(null),
  editing = ref(false),
  baseline = ref(""),
  changes = ref<RelationPublishInput["changes"]>([]),
  uncertain = ref(false);
const { scope, discard } = useManagementPage(
  () => {
    graph.value = null;
    draft.value = empty();
    origin.value = null;
    editing.value = false;
    changes.value = [];
    uncertain.value = false;
  },
  () =>
    changes.value.length > 0 || (editing.value && stableStringify(draft.value) !== baseline.value),
);
const source = computed(() =>
    props.datasets.find((item) => item.object_id === (origin.value?.object_id ?? props.objectId)),
  ),
  target = computed(() =>
    props.datasets.find((item) => item.object_id === draft.value.target_object_id),
  );
async function read() {
  if (!(await discard())) return;
  await scope.run(async (request) => {
    graph.value = await new CatalogApi(request).graph(props.sourceId, props.objectId);
    changes.value = [];
    editing.value = false;
    uncertain.value = false;
  });
}
async function edit(value?: CatalogRelation) {
  if (
    editing.value &&
    stableStringify(draft.value) !== baseline.value &&
    !(await confirmManagement("放弃当前关系尚未加入发布清单的编辑？", "切换关系"))
  )
    return;
  origin.value = value ?? null;
  draft.value = value
    ? publishedRelationInputSchema.parse({
        relation_id: value.relation_id,
        target_object_id: value.target_object_id,
        description: value.description,
        column_pairs: value.column_pairs,
        cardinality: value.cardinality,
        allowed_join_types: value.allowed_join_types,
      })
    : empty();
  baseline.value = stableStringify(draft.value);
  editing.value = true;
}
function enqueue() {
  return scope.run(async () => {
    const relation = publishedRelationInputSchema.parse(draft.value);
    const change = origin.value
      ? {
          action: "update" as const,
          object_id: origin.value.object_id,
          expected_version: origin.value.version,
          relation,
        }
      : { action: "create" as const, object_id: props.objectId, relation };
    changes.value = relationPublishInputSchema.parse({
      changes: [...changes.value, change],
    }).changes;
    editing.value = false;
  });
}
async function disable(value: CatalogRelation) {
  if (
    !(await confirmManagement(
      `停用 ${value.object_id} → ${value.target_object_id} 的 ${value.relation_id} 关系？该操作将在发布整批时执行。`,
      "停用关系",
    ))
  )
    return;
  await scope.run(async () => {
    changes.value = relationPublishInputSchema.parse({
      changes: [
        ...changes.value,
        {
          action: "disable",
          object_id: value.object_id,
          relation_id: value.relation_id,
          expected_version: value.version,
        },
      ],
    }).changes;
  });
}
function publish() {
  return scope.run(async (request) => {
    const api = new CatalogApi(request);
    try {
      await api.publish(props.sourceId, { changes: changes.value });
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ) {
        graph.value = await api.graph(props.sourceId, props.objectId);
        uncertain.value = true;
        scope.state.notice =
          "发布状态需要核对。下方显示已回读的服务端关系，待发布清单保留。请按最新版本重新准备变更。";
        return;
      }
      throw error;
    }
    changes.value = [];
    graph.value = await api.graph(props.sourceId, props.objectId);
    scope.state.notice = "关系整批已发布并回读。";
    emit("published");
  });
}
async function resetChanges() {
  if (
    !(await confirmManagement("清除待发布清单，再按当前服务端版本准备变更？", "重新准备关系变更"))
  )
    return;
  changes.value = [];
  editing.value = false;
  uncertain.value = false;
}
onMounted(read);
defineExpose({ canLeave: discard });
</script>
<template>
  <section class="management-section">
    <h3>业务关系</h3>
    <p class="management-help">
      箭头保留实际批准方向。多对多、一对多可能放大记录数；关系基数由字段及唯一键规则校验。
    </p>
    <p v-if="disabled" class="management-help">先保存上方业务配置，再发布关系变更。</p>
    <ManagementFeedback v-bind="scope.state" />
    <div class="management-actions">
      <ElButton :disabled="scope.state.busy" @click="read">刷新关系</ElButton
      ><ElButton :disabled="disabled || scope.state.busy || uncertain" @click="edit()"
        >新建出向关系</ElButton
      >
    </div>
    <template v-if="graph"
      ><RelationsGraph :graph="graph" />
      <div
        v-for="row in [...graph.outgoing, ...graph.incoming]"
        :key="`${row.object_id}:${row.relation_id}`"
        class="management-section"
      >
        <strong>{{ row.object_id }} → {{ row.target_object_id }}</strong>
        <p>
          {{ row.relation_id }} · v{{ row.version }} · {{ row.cardinality ?? "由唯一键确定" }} ·
          {{ row.enabled ? "启用" : "停用" }}
        </p>
        <p class="muted">
          {{ row.description }} ·
          {{
            row.column_pairs
              .map((pair) => `${pair.source_column} = ${pair.target_column}`)
              .join(" AND ")
          }}
        </p>
        <ElButton :disabled="disabled || scope.state.busy || uncertain" @click="edit(row)"
          >编辑关系</ElButton
        ><ElButton
          v-if="row.enabled"
          :disabled="disabled || scope.state.busy || uncertain"
          @click="disable(row)"
          >加入停用清单</ElButton
        >
      </div></template
    >
    <ElForm
      v-if="editing"
      label-position="top"
      :disabled="disabled || scope.state.busy || uncertain"
      @submit.prevent
      ><p>方向：{{ origin?.object_id ?? objectId }} → {{ draft.target_object_id || "目标对象" }}</p>
      <div class="management-form-grid">
        <ElFormItem label="关系标识" required
          ><ElInput v-model="draft.relation_id" :disabled="!!origin" /></ElFormItem
        ><ElFormItem label="目标对象" required
          ><ElSelect
            v-model="draft.target_object_id"
            aria-label="目标对象"
            filterable
            :disabled="!!origin"
            ><ElOption
              v-for="item in datasets"
              :key="item.object_id"
              :value="item.object_id"
              :label="item.object_id" /></ElSelect></ElFormItem
        ><ElFormItem label="业务说明" class="wide" required
          ><ElInput v-model="draft.description" /></ElFormItem
        ><ElFormItem label="基数"
          ><ElSelect v-model="draft.cardinality" clearable
            ><ElOption
              v-for="value in ['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']"
              :key="value"
              :value="value"
              :label="value" /></ElSelect></ElFormItem
        ><ElFormItem label="允许连接类型"
          ><ElSelect v-model="draft.allowed_join_types" multiple
            ><ElOption
              v-for="value in ['inner', 'left', 'right']"
              :key="value"
              :label="value.toUpperCase()"
              :value="value" /></ElSelect
        ></ElFormItem>
      </div>
      <div v-for="(pair, index) in draft.column_pairs" :key="index" class="management-inline-row">
        <ElSelect v-model="pair.source_column" filterable :aria-label="`源字段 ${index + 1}`"
          ><ElOption
            v-for="column in source?.columns ?? []"
            :key="column.name"
            :label="column.name"
            :value="column.name" /></ElSelect
        ><span>=</span
        ><ElSelect v-model="pair.target_column" filterable :aria-label="`目标字段 ${index + 1}`"
          ><ElOption
            v-for="column in target?.columns ?? []"
            :key="column.name"
            :label="column.name"
            :value="column.name" /></ElSelect
        ><ElButton @click="draft.column_pairs.splice(index, 1)">移除</ElButton>
      </div>
      <div class="management-actions">
        <ElButton @click="draft.column_pairs.push({ source_column: '', target_column: '' })"
          >添加字段对</ElButton
        ><ElButton type="primary" @click="enqueue">加入发布清单</ElButton>
      </div></ElForm
    >
    <section v-if="changes.length" class="management-section">
      <h3>待发布 {{ changes.length }} 项</h3>
      <pre class="management-code">{{ JSON.stringify(changes, null, 2) }}</pre>
      <div class="management-actions">
        <ElButton
          type="primary"
          :loading="scope.state.busy"
          :disabled="disabled || uncertain"
          @click="publish"
          >发布整批关系</ElButton
        ><ElButton :disabled="scope.state.busy" @click="resetChanges">清除并重新准备</ElButton>
      </div>
    </section>
  </section>
</template>
