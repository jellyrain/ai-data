<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { ElButton, ElDialog, ElInput } from "element-plus";
import { ArrowLeft, Database, Plus, X, Search, PanelLeftClose } from "lucide-vue-next";
import {
  publishedRelationInputSchema,
  stableStringify,
  type PublishedRelationInput,
  type CatalogRelation,
  type RelationGraph,
  type Dataset,
  type RelationPublishInput,
} from "@ai-data/contracts";
import type { Connection } from "@vue-flow/core";
import { CatalogApi } from "../api/catalog-api";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import { ApiError } from "../../../shared/http/api-error";
import { createUuid } from "../../../shared/identity/create-uuid";
import {
  changeKey,
  relationKey,
  relationInput,
  mergeRelations,
  stageRelationChange,
  relationViews,
  rebaseRelationChanges,
} from "../stores/relation-draft";
import RelationsGraph from "./relations-graph.vue";
import RelationCanvas from "./relation-canvas.vue";
import RelationInspector from "./relation-inspector.vue";
import "../../../styles/relation-canvas.css";
const props = defineProps<{
  sourceId: string;
  objectId: string;
  datasets: Dataset[];
  disabled: boolean;
}>();
const emit = defineEmits<{ published: [] }>();
const empty = (): PublishedRelationInput => ({
  relation_id: `rel_${createUuid().replaceAll("-", "")}`,
  target_object_id: "",
  description: "",
  column_pairs: [{ source_column: "", target_column: "" }],
  allowed_join_types: ["inner"],
});
const open = ref(false),
  graph = ref<RelationGraph | null>(null),
  rows = ref<CatalogRelation[]>([]),
  changes = ref<RelationPublishInput["changes"]>([]),
  uncertain = ref(false);
const objects = ref<string[]>([]),
  expanded = ref<string[]>([]),
  positions = ref<Record<string, { x: number; y: number }>>({});
const draft = ref(empty()),
  source = ref(props.objectId),
  editing = ref(false),
  selected = ref(""),
  baseline = ref("");
const picker = ref(true),
  listTab = ref("objects"),
  search = ref(""),
  showChanges = ref(false);
const canvas = ref<InstanceType<typeof RelationCanvas>>();
const formValue = () => stableStringify({ source: source.value, relation: draft.value });
const formDirty = computed(() => editing.value && formValue() !== baseline.value);
const { scope, discard } = useManagementPage(
  () => {
    open.value = false;
    graph.value = null;
    rows.value = [];
    changes.value = [];
    editing.value = false;
    objects.value = [];
    expanded.value = [];
    positions.value = {};
    uncertain.value = false;
    selected.value = "";
    draft.value = empty();
    baseline.value = "";
  },
  () => changes.value.length > 0 || formDirty.value,
);
const locked = computed(() => props.disabled || scope.state.busy || uncertain.value);
const views = computed(() => relationViews(props.sourceId, rows.value, changes.value));
const query = computed(() => search.value.toLocaleLowerCase().trim());
const datasets = computed(() =>
  props.datasets.filter((item) => item.kind === "table" || item.kind === "view"),
);
const matching = computed(() =>
  datasets.value
    .filter((item) =>
      `${item.name} ${item.object_id} ${item.source_description ?? ""}`
        .toLocaleLowerCase()
        .includes(query.value),
    )
    .slice(0, 100),
);
const filteredRelations = computed(() =>
  views.value.filter(({ relation }) =>
    `${relation.description} ${relation.relation_id} ${relation.object_id} ${relation.target_object_id}`
      .toLocaleLowerCase()
      .includes(query.value),
  ),
);
const current = computed(() => views.value.find((item) => item.key === selected.value));
const existing = computed(() =>
  rows.value.some((row) => relationKey(row.object_id, row.relation_id) === selected.value),
);
function name(id: string) {
  return props.datasets.find((item) => item.object_id === id)?.name ?? id;
}
function status(action?: string) {
  return action === "create"
    ? "新增"
    : action === "update"
      ? "修改"
      : action === "disable"
        ? "停用"
        : "已发布";
}
function add(id: string) {
  if (id && !objects.value.includes(id)) objects.value = [...objects.value, id];
}
function absorb(value: RelationGraph) {
  rows.value = mergeRelations(rows.value, value);
  if (value.object_id === props.objectId) graph.value = value;
  if (!expanded.value.includes(value.object_id))
    expanded.value = [...expanded.value, value.object_id];
  add(value.object_id);
  for (const row of [...value.outgoing, ...value.incoming]) {
    add(row.object_id);
    add(row.target_object_id);
  }
}
async function read() {
  if (!(await discard())) return;
  await scope.run(async (request) => {
    const value = await new CatalogApi(request).graph(props.sourceId, props.objectId);
    rows.value = [];
    objects.value = [];
    expanded.value = [];
    changes.value = [];
    editing.value = false;
    uncertain.value = false;
    absorb(value);
  });
}
async function expand(id: string) {
  await scope.run(async (request) =>
    absorb(await new CatalogApi(request).graph(props.sourceId, id)),
  );
  await nextTick();
  canvas.value?.fit();
}
async function openCanvas() {
  if (props.disabled || scope.state.busy) return;
  if (!graph.value) await read();
  open.value = true;
}
async function closeCanvas() {
  if (!(await discard())) return;
  changes.value = [];
  editing.value = false;
  uncertain.value = false;
  selected.value = "";
  open.value = false;
  await read();
}
async function leaveForm() {
  return !formDirty.value || (await confirmManagement("放弃当前关系尚未应用的修改？", "切换关系"));
}
async function create(
  id = props.objectId,
  connection?: Connection,
  position?: { x: number; y: number },
) {
  if (locked.value || !(await leaveForm())) return;
  source.value = id;
  selected.value = "";
  draft.value = empty();
  if (connection) {
    draft.value.target_object_id = connection.target;
    if (position && !objects.value.includes(connection.target))
      positions.value = { ...positions.value, [connection.target]: position };
  }
  add(id);
  editing.value = true;
  baseline.value = formValue();
}
async function edit(key: string) {
  if (scope.state.busy || !(await leaveForm())) return;
  const view = views.value.find((item) => item.key === key);
  if (!view) return;
  selected.value = key;
  source.value = view.relation.object_id;
  draft.value = relationInput(view.relation);
  editing.value = true;
  baseline.value = formValue();
}
async function closeInspector() {
  if (await leaveForm()) {
    editing.value = false;
    selected.value = "";
  }
}
function apply() {
  if (locked.value) return;
  return scope.run(async () => {
    const input = publishedRelationInputSchema.parse({
      ...draft.value,
      cardinality: draft.value.cardinality || undefined,
    });
    const key = relationKey(source.value, input.relation_id);
    if (!source.value || !datasets.value.some((item) => item.object_id === source.value)) {
      scope.state.error = "请选择可关联的源对象。";
      return;
    }
    if (selected.value !== key && views.value.some((item) => item.key === key)) {
      scope.state.error = "该源对象已有同标识关系，请使用其他标识。";
      return;
    }
    const old = rows.value.find((row) => relationKey(row.object_id, row.relation_id) === key);
    const pending = changes.value.filter(
      (item) => !selected.value || changeKey(item) !== selected.value,
    );
    changes.value = stageRelationChange(
      pending,
      old
        ? {
            action: "update",
            object_id: old.object_id,
            expected_version: old.version,
            relation: input,
          }
        : { action: "create", object_id: source.value, relation: input },
    );
    if (!expanded.value.includes(source.value)) expanded.value = [...expanded.value, source.value];
    add(source.value);
    add(input.target_object_id);
    selected.value = key;
    editing.value = false;
  });
}
async function disable() {
  const value = current.value?.relation;
  if (
    !value ||
    locked.value ||
    !(await confirmManagement(
      `停用 ${name(value.object_id)} → ${name(value.target_object_id)} 的关系？发布后生效。`,
      "停用关系",
    ))
  )
    return;
  changes.value = stageRelationChange(changes.value, {
    action: "disable",
    object_id: value.object_id,
    relation_id: value.relation_id,
    expected_version: value.version,
  });
  editing.value = false;
}
async function undo(key: string) {
  if (scope.state.busy || !(await leaveForm())) return;
  changes.value = changes.value.filter((item) => changeKey(item) !== key);
  editing.value = false;
  selected.value = "";
}
async function loadExpanded(api: CatalogApi) {
  const values = await Promise.all(
    [...new Set([props.objectId, ...expanded.value])].map((id) => api.graph(props.sourceId, id)),
  );
  rows.value = [];
  for (const value of values) absorb(value);
}
async function publish() {
  if (locked.value || !changes.value.length || formDirty.value) return;
  await scope.run(async (request) => {
    const api = new CatalogApi(request);
    try {
      await api.publish(props.sourceId, { changes: changes.value });
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ) {
        uncertain.value = true;
        scope.state.notice = "发布状态需要核对，待发布修改已保留。查看服务端当前内容后再继续。";
        showChanges.value = true;
        await loadExpanded(api);
        return;
      }
      throw error;
    }
    // 发布回执已经确认，后续读取失败不应重复发送这批变更。
    changes.value = [];
    editing.value = false;
    uncertain.value = false;
    selected.value = "";
    emit("published");
    await loadExpanded(api);
    scope.state.notice = "关系整批已发布并回读。";
  });
}
async function rebase() {
  if (
    scope.state.busy ||
    !(await confirmManagement(
      "采用服务端最新版本继续当前修改；已生效的变更将从清单移除。请先核对清单内的服务端内容。",
      "核对关系变更",
    ))
  )
    return;
  await scope.run(async (request) => {
    await loadExpanded(new CatalogApi(request));
    try {
      changes.value = rebaseRelationChanges(changes.value, rows.value);
      uncertain.value = false;
      editing.value = false;
    } catch (error) {
      scope.state.error = error instanceof Error ? error.message : "关系状态无法核对";
    }
  });
}
function serverFor(key: string) {
  return rows.value.find((row) => relationKey(row.object_id, row.relation_id) === key);
}
function dragged(event: DragEvent) {
  event.dataTransfer?.setData(
    "application/x-ai-data-object",
    (event.currentTarget as HTMLElement).dataset.object ?? "",
  );
}
function dropped(event: DragEvent) {
  const id = event.dataTransfer?.getData("application/x-ai-data-object");
  if (id && datasets.value.some((item) => item.object_id === id)) add(id);
}
onMounted(read);
defineExpose({ canLeave: discard });
</script>
<template>
  <section class="management-section">
    <div class="relation-preview-heading">
      <div>
        <h3>业务关系</h3>
        <p class="management-help">连接两个数据对象，在关联设置中选择字段和规则。</p>
      </div>
      <ElButton type="primary" :disabled="disabled || scope.state.busy" @click="openCanvas"
        >编辑关系画布</ElButton
      >
    </div>
    <p v-if="disabled" class="management-help">先保存业务配置，再编辑关系。</p>
    <ManagementFeedback v-if="!open" v-bind="scope.state" />
    <RelationsGraph v-if="graph" :graph="graph" />
    <ElButton v-if="!graph" :loading="scope.state.busy" @click="read">重新读取关系</ElButton>
    <ElDialog
      v-model="open"
      title="业务关系画布"
      fullscreen
      append-to-body
      destroy-on-close
      class="relation-workspace"
      :show-close="false"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
    >
      <template #header
        ><header class="editor-topbar relation-topbar">
          <div class="editor-title-group">
            <ElButton
              text
              aria-label="返回业务目录"
              :disabled="scope.state.busy"
              @click="closeCanvas"
              ><ArrowLeft :size="17" />返回业务目录</ElButton
            >
            <h2>业务关系</h2>
            <span class="muted">{{ sourceId }}</span>
          </div>
          <div class="editor-save-actions">
            <span class="editor-save-state">{{
              changes.length ? `待发布 ${changes.length} 项` : "已同步"
            }}</span
            ><ElButton :disabled="locked" @click="create()">新建关系</ElButton
            ><ElButton :aria-pressed="showChanges" @click="showChanges = !showChanges"
              >查看变更</ElButton
            ><ElButton
              type="primary"
              :disabled="locked || !changes.length || formDirty"
              :loading="scope.state.busy"
              @click="publish"
              >发布关系</ElButton
            >
          </div>
        </header></template
      >
      <div v-if="scope.state.error || scope.state.notice || formDirty" class="relation-feedback">
        <ManagementFeedback v-bind="scope.state" />
        <p v-if="formDirty" class="muted">当前属性尚未应用。点击“应用修改”后可统一发布。</p>
      </div>
      <div
        class="relation-workspace-body"
        :class="{ 'has-picker': picker, 'has-inspector': editing || showChanges }"
      >
        <aside v-if="picker" class="relation-object-picker" aria-label="画布对象列表">
          <header>
            <strong>数据与关系</strong
            ><ElButton text aria-label="收起对象列表" @click="picker = false"
              ><PanelLeftClose :size="16"
            /></ElButton>
          </header>
          <nav>
            <button :aria-pressed="listTab === 'objects'" @click="listTab = 'objects'">
              表与视图</button
            ><button :aria-pressed="listTab === 'relations'" @click="listTab = 'relations'">
              关系 {{ views.length }}
            </button>
          </nav>
          <ElInput
            v-model="search"
            aria-label="搜索画布对象或关系"
            placeholder="搜索名称或注释"
            :prefix-icon="Search"
            clearable
          />
          <div class="relation-picker-list">
            <template v-if="listTab === 'objects'"
              ><div
                v-for="item in matching"
                :key="item.object_id"
                class="relation-object-row"
                :data-object="item.object_id"
                :draggable="!locked"
                @dragstart="dragged"
              >
                <Database :size="16" />
                <div>
                  <strong :title="item.name">{{ item.name }}</strong
                  ><small :title="item.object_id">{{ item.object_id }}</small>
                </div>
                <span v-if="objects.includes(item.object_id)" class="muted">已添加</span
                ><ElButton
                  v-else
                  text
                  :disabled="locked"
                  :aria-label="`添加对象 ${item.object_id}`"
                  @click="add(item.object_id)"
                  ><Plus :size="17"
                /></ElButton>
              </div>
              <p v-if="!matching.length" class="management-help">没有匹配的表或视图。</p>
              <p v-if="matching.length === 100" class="management-help">
                已显示前 100 项，可搜索定位更多对象。
              </p></template
            >
            <template v-else
              ><button
                v-for="view in filteredRelations"
                :key="view.key"
                class="relation-list-row"
                :aria-pressed="selected === view.key"
                @click="edit(view.key)"
              >
                <strong>{{ view.relation.description }}</strong
                ><small
                  >{{ name(view.relation.object_id) }} →
                  {{ name(view.relation.target_object_id) }}</small
                ><small>{{
                  !view.relation.enabled && !view.change ? "已停用" : status(view.change)
                }}</small>
              </button>
              <p v-if="!filteredRelations.length" class="management-help">
                暂无匹配的关系，可连接两个数据对象建立关系。
              </p></template
            >
          </div>
          <p class="relation-picker-hint muted">拖入画布或点击 + 添加对象</p>
        </aside>
        <main class="relation-canvas-region" @dragover.prevent @drop.prevent="dropped">
          <RelationCanvas
            ref="canvas"
            :datasets="datasets"
            :objects="objects"
            :relations="views"
            :positions="positions"
            :selected="selected"
            :preview="
              editing && source && draft.target_object_id
                ? {
                    source,
                    target: draft.target_object_id,
                    description: draft.description,
                    key: selected,
                  }
                : undefined
            "
            :locked="locked"
            @connect="(connection, position) => create(connection.source, connection, position)"
            @edit="edit"
            @create="create"
            @expand="expand"
            @move="(id, position) => (positions = { ...positions, [id]: position })"
            @picker="picker = $event ?? !picker"
          />
        </main>
        <RelationInspector
          v-if="editing"
          v-model="draft"
          v-model:source="source"
          :datasets="datasets"
          :existing="existing"
          :disabled="locked"
          :can-disable="existing && !!current?.relation.enabled"
          @apply="apply"
          @close="closeInspector"
          @disable="disable"
        />
        <aside v-else-if="showChanges" class="relation-changes" aria-label="待发布变更">
          <header>
            <strong>待发布变更</strong
            ><ElButton text aria-label="关闭变更清单" @click="showChanges = false"
              ><X :size="17"
            /></ElButton>
          </header>
          <div class="relation-changes-list">
            <p v-if="!changes.length" class="management-help">暂无待发布修改。</p>
            <section v-for="change in changes" :key="changeKey(change)">
              <strong
                >{{ status(change.action) }} ·
                {{
                  change.action === "disable"
                    ? serverFor(changeKey(change))?.description
                    : change.relation.description
                }}</strong
              >
              <p class="muted">
                {{ name(change.object_id) }} →
                {{
                  name(
                    change.action === "disable"
                      ? (serverFor(changeKey(change))?.target_object_id ?? "")
                      : change.relation.target_object_id,
                  )
                }}
              </p>
              <p v-if="change.action !== 'disable'" class="relation-pair-summary">
                {{
                  change.relation.column_pairs
                    .map((pair) => `${pair.source_column} = ${pair.target_column}`)
                    .join("；")
                }}
              </p>
              <details v-if="uncertain">
                <summary>服务端当前内容</summary>
                <template v-if="serverFor(changeKey(change))"
                  ><p>
                    v{{ serverFor(changeKey(change))!.version }} ·
                    {{ serverFor(changeKey(change))!.enabled ? "启用" : "停用" }}
                  </p>
                  <p>{{ serverFor(changeKey(change))!.description }}</p>
                  <p class="relation-pair-summary">
                    {{
                      serverFor(changeKey(change))!
                        .column_pairs.map((pair) => `${pair.source_column} = ${pair.target_column}`)
                        .join("；")
                    }}
                  </p></template
                >
                <p v-else>服务端尚无这条关系。</p>
              </details>
              <ElButton text :disabled="scope.state.busy" @click="edit(changeKey(change))"
                >查看属性</ElButton
              ><ElButton text :disabled="scope.state.busy" @click="undo(changeKey(change))"
                >撤销此项</ElButton
              >
            </section>
          </div>
          <footer v-if="uncertain">
            <ElButton :disabled="scope.state.busy" @click="rebase">已核对，采用最新版本</ElButton>
          </footer>
        </aside>
      </div>
    </ElDialog>
  </section>
</template>
