<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";
import {
  ElButton,
  ElDrawer,
  ElInput,
  ElOption,
  ElSelect,
  ElSkeleton,
  ElMessageBox,
} from "element-plus";
import { ArrowLeft, Plus, X, SlidersHorizontal, Sparkles } from "lucide-vue-next";
import { useServices } from "../../../app/services";
import { useLayoutStore } from "../../../app/layout-store";
import ReportRevision from "../components/report-revision.vue";
import ParameterEditor from "../components/parameter-editor.vue";
import QueryEditor from "../components/query-editor.vue";
import DatasetPicker from "../components/dataset-picker.vue";
import RelationPicker from "../components/relation-picker.vue";
import PresentationEditor from "../components/presentation-editor.vue";
import ReportPreview from "../components/report-preview.vue";
import ParameterBindings from "../components/parameter-bindings.vue";
import ParameterForm from "../components/parameter-form.vue";
const ReportCanvas = defineAsyncComponent(() => import("../components/report-canvas.vue"));
const { reportEditor: editor, reportRevisions: revisions } = useServices(),
  state = editor.state;
const route = useRoute(),
  router = useRouter(),
  layout = useLayoutStore();
const mode = ref("form"),
  tab = ref("presentation"),
  queryId = ref(""),
  alias = ref(""),
  adding = ref(false),
  inspector = ref(false),
  aiOpen = ref(false);
const relation = ref<{ source: string; target?: string }>();
const locked = computed(() => state.saving || state.locked || state.uncertain);
watch(
  () =>
    tab.value === "parameters" && state.ready
      ? [
          ...new Set(
            state.draft.queries.flatMap((q) =>
              q.query.type === "metric_query" ? [] : [q.query.source_id],
            ),
          ),
        ].join("|")
      : "",
  (sources) => {
    if (sources) for (const source of sources.split("|")) void editor.loadDatasets(source);
  },
);
let savedNavigation = false;
let pageGeneration = 0;
let templateKey = "";
watch(mode, (value) => {
  layout.canvas = value === "canvas";
  inspector.value = false;
});
watch(
  () => [route.params.id, route.query.revision, route.query.template, route.query.version],
  async () => {
    const id = route.params.id ? String(route.params.id) : "";
    const generation = ++pageGeneration;
    const nextTemplateKey = id
      ? ""
      : String(route.query.template ?? "") + ":" + String(route.query.version ?? "");
    if (id !== state.reportId || !state.ready || nextTemplateKey !== templateKey) {
      templateKey = nextTemplateKey;
      if (!id && typeof route.query.template === "string")
        await editor.openTemplate(route.query.template, Number(route.query.version));
      else await editor.open(id);
      if (generation !== pageGeneration) return;
      queryId.value = state.draft.queries[0]?.query_id ?? "";
      alias.value = "";
      revisions.select(state.reportId);
      if (route.query.ai === "1") aiOpen.value = true;
    }
    const revision = route.query.revision;
    if (
      state.ready &&
      typeof revision === "string" &&
      revision !== revisions.state.receipt?.analysis_run_id
    ) {
      aiOpen.value = true;
      await revisions.restore(revision);
    }
  },
  { immediate: true },
);
watch(
  () => state.draft.queries.map((q) => q.query_id),
  (ids) => {
    if (!ids.includes(queryId.value)) queryId.value = ids[0] ?? "";
  },
);
watch(queryId, () => {
  alias.value = "";
});
watch(
  () => state.reportId,
  (id) => {
    if (id !== revisions.state.reportId) revisions.select(id);
  },
);
watch(
  () => revisions.state.receipt,
  (receipt) => {
    if (receipt) void router.replace({ query: { revision: receipt.analysis_run_id } });
  },
);
function added(id: string) {
  queryId.value = id;
  adding.value = false;
  tab.value = "queries";
  inspector.value = true;
}
function inspect(value: string) {
  alias.value = value;
  tab.value = "queries";
  inspector.value = true;
}
function openRelation(source: string, target?: string) {
  relation.value = { source, target };
}
async function save() {
  if (!(await editor.save())) return false;
  savedNavigation = true;
  await router.replace(`/reports/${encodeURIComponent(state.reportId)}/edit`);
  savedNavigation = false;
  return true;
}
async function beforeLeave() {
  if (savedNavigation || (!editor.dirty && !state.locked && !state.uncertain)) return true;
  if (state.locked || state.uncertain) {
    try {
      await ElMessageBox.confirm(
        "当前操作结果仍待确认。离开后可从报表中心检查已保存版本。",
        "离开编辑器",
        { confirmButtonText: "离开", cancelButtonText: "继续查看" },
      );
      return true;
    } catch {
      return false;
    }
  }
  try {
    await ElMessageBox.confirm("草稿尚未保存。保存后离开，或放弃这次改动。", "未保存的改动", {
      confirmButtonText: "保存并离开",
      cancelButtonText: "放弃改动",
      distinguishCancelAndClose: true,
    });
    return await editor.save();
  } catch (action) {
    return action === "cancel";
  }
}
onBeforeRouteLeave(beforeLeave);
onBeforeRouteUpdate((to, from) =>
  to.params.id !== from.params.id ||
  (to.query.revision !== from.query.revision &&
    to.query.revision !== revisions.state.receipt?.analysis_run_id)
    ? beforeLeave()
    : true,
);
function beforeUnload(event: BeforeUnloadEvent) {
  if (editor.dirty || state.locked || state.uncertain) {
    event.preventDefault();
    event.returnValue = "";
  }
}
window.addEventListener("beforeunload", beforeUnload);
onBeforeUnmount(() => {
  pageGeneration++;
  layout.canvas = false;
  window.removeEventListener("beforeunload", beforeUnload);
  revisions.leave();
  editor.leave();
});
async function allowRetry() {
  try {
    await ElMessageBox.confirm(
      "请先在报表中心核对是否已创建。确认没有后再创建，避免重复报表。",
      "确认创建结果",
      { confirmButtonText: "已核对，允许重新创建", cancelButtonText: "返回检查" },
    );
    editor.allowCreateRetry();
  } catch {
    /* 保留待确认草稿。 */
  }
}
</script>
<template>
  <section
    class="report-editor-page"
    :class="{ 'is-canvas': mode === 'canvas', 'has-ai-panel': aiOpen }"
  >
    <header class="editor-topbar">
      <div class="editor-title-group">
        <RouterLink to="/reports" class="editor-back" aria-label="返回报表中心"
          ><ArrowLeft :size="18" /></RouterLink
        ><ElInput
          :model-value="state.draft.title"
          aria-label="报表标题"
          :disabled="!state.ready || locked"
          @update:model-value="editor.update({ ...state.draft, title: String($event) })"
        />
      </div>
      <div class="editor-save-actions">
        <ElButton :disabled="!state.baseline" @click="aiOpen = !aiOpen"
          ><Sparkles :size="15" />AI 修改</ElButton
        >
        <span class="editor-save-state"
          >{{ state.baseline ? `v${state.baseline.version}` : "新建"
          }}<span v-if="editor.dirty"> · 未保存</span></span
        ><ElButton
          v-if="state.reportId"
          text
          @click="router.push(`/reports/${encodeURIComponent(state.reportId)}`)"
          >查看报表</ElButton
        ><ElButton
          type="primary"
          :loading="state.saving"
          :disabled="!state.ready || locked || !!state.latest"
          @click="save"
          >保存</ElButton
        >
      </div>
    </header>
    <nav class="report-editor-tabs" aria-label="报表编辑分区">
      <button
        :aria-current="mode === 'form' && tab === 'parameters' ? 'page' : undefined"
        @click="
          mode = 'form';
          tab = 'parameters';
        "
      >
        筛选条件
      </button>
      <button
        :aria-current="mode === 'form' && tab !== 'parameters' ? 'page' : undefined"
        @click="
          mode = 'form';
          tab = 'presentation';
        "
      >
        数据与展示
      </button>
      <button :aria-current="mode === 'canvas' ? 'page' : undefined" @click="mode = 'canvas'">
        数据编排
      </button>
    </nav>
    <ElSkeleton v-if="state.loading" :rows="8" animated />
    <div
      v-if="state.error || state.notice || state.issues.length || state.latest || state.uncertain"
      class="editor-feedback"
      aria-live="polite"
    >
      <p v-if="state.error" class="inline-error" role="alert">{{ state.error }}</p>
      <p v-if="state.notice">{{ state.notice }}</p>
      <details v-if="state.issues.length" open>
        <summary>请检查 {{ state.issues.length }} 处定义问题</summary>
        <ul>
          <li v-for="issue in state.issues" :key="issue">{{ issue }}</li>
        </ul>
      </details>
      <div v-if="state.latest" class="editor-conflict">
        <strong>服务端已有 v{{ state.latest.version }}，当前草稿已保留</strong>
        <div class="conflict-diff">
          <details>
            <summary>当前草稿</summary>
            <pre>{{ JSON.stringify(state.draft, null, 2) }}</pre>
          </details>
          <details>
            <summary>服务端版本</summary>
            <pre>{{ JSON.stringify(state.latest.definition, null, 2) }}</pre>
          </details>
        </div>
        <ElButton @click="editor.resolveConflict('server')">采用服务端版本</ElButton
        ><ElButton @click="editor.resolveConflict('local')">以最新版本继续当前草稿</ElButton>
      </div>
      <div v-if="state.uncertain">
        <p>保存结果待确认，草稿已保留。</p>
        <ElButton v-if="state.reportId" @click="editor.checkSaved()">核对保存结果</ElButton
        ><template v-else
          ><a href="/reports" target="_blank" rel="noopener">打开报表中心核对</a
          ><ElButton @click="allowRetry">已核对创建结果</ElButton></template
        >
      </div>
    </div>
    <template v-if="state.ready"
      ><div v-if="mode === 'form'" class="editor-form-layout">
        <fieldset class="editor-form-main" :disabled="locked">
          <div v-if="tab === 'parameters'" class="parameter-edit-layout">
            <div>
              <ParameterEditor
                :model-value="state.draft"
                @update:model-value="editor.update($event)"
              >
                <template #bindings="{ parameter }"
                  ><ParameterBindings
                    :model-value="state.draft"
                    :parameter="parameter"
                    :datasets="state.datasets"
                    @update:model-value="editor.update($event)"
                /></template>
                <template #preview>
                  <section class="parameter-preview">
                    <h2>使用预览</h2>
                    <p class="muted">用户将在报表中看到这些筛选项。</p>
                    <ParameterForm
                      :definition="{
                        ...(state.baseline ?? {
                          report_id: '',
                          organization_id: '',
                          user_id: '',
                          created_at: '',
                          version: 1,
                          shared_with: [],
                        }),
                        definition: state.draft,
                      }"
                      :busy="false"
                      :uncertain="false"
                      compact
                      preview
                    />
                    <details class="parameter-saved-preview">
                      <summary>查看上次保存结果</summary>
                      <ReportPreview :report-id="state.reportId" />
                    </details>
                  </section>
                </template>
              </ParameterEditor>
              <p v-if="state.catalogError" role="alert" class="inline-error">
                {{ state.catalogError
                }}<ElButton
                  text
                  @click="
                    state.draft.queries.forEach(
                      (q) =>
                        q.query.type !== 'metric_query' &&
                        editor.loadDatasets(q.query.source_id, true),
                    )
                  "
                  >重新读取字段</ElButton
                >
              </p>
            </div>
          </div>
          <PresentationEditor v-else-if="tab === 'presentation'" :editor="editor" /><template v-else
            ><header class="editor-section-heading">
              <div>
                <h2>数据查询</h2>
                <p class="muted">选择数据对象，配置字段与业务关系。</p>
              </div>
              <ElButton :disabled="state.draft.queries.length >= 100" @click="adding = true"
                ><Plus :size="15" />添加查询</ElButton
              >
            </header>
            <ElSelect v-if="state.draft.queries.length" v-model="queryId" aria-label="当前查询"
              ><ElOption
                v-for="query in state.draft.queries"
                :key="query.query_id"
                :value="query.query_id"
                :label="query.query_id" /></ElSelect
            ><QueryEditor
              v-if="queryId"
              :editor="editor"
              :query-id="queryId"
              :alias="alias"
              @relation="openRelation"
              @renamed="queryId = $event"
              @alias-selected="alias = $event"
            />
            <div v-else class="editor-start">
              <h3>先选择一份数据</h3>
              <p class="muted">从授权数据对象或已发布指标开始。</p>
              <ElButton type="primary" @click="adding = true">添加第一个查询</ElButton>
            </div></template
          >
          <details
            v-if="tab === 'presentation'"
            class="report-query-settings"
            :open="!state.draft.queries.length"
          >
            <summary>数据查询与聚合设置</summary>
            <header class="editor-section-heading">
              <h2>数据查询</h2>
              <ElButton @click="adding = true">添加查询</ElButton>
            </header>
            <ElSelect v-if="state.draft.queries.length" v-model="queryId" aria-label="当前查询"
              ><ElOption
                v-for="query in state.draft.queries"
                :key="query.query_id"
                :value="query.query_id"
                :label="query.query_id" /></ElSelect
            ><QueryEditor
              v-if="queryId"
              :editor="editor"
              :query-id="queryId"
              :alias="alias"
              @relation="openRelation"
              @renamed="queryId = $event"
              @alias-selected="alias = $event"
            /><ElButton v-else type="primary" @click="adding = true">添加第一个查询</ElButton>
          </details>
        </fieldset>
      </div>
      <div v-else class="editor-canvas-body">
        <div v-if="state.draft.queries.length" class="canvas-query-select canvas-floating">
          <ElSelect v-model="queryId" aria-label="画布当前查询"
            ><ElOption
              v-for="query in state.draft.queries"
              :key="query.query_id"
              :value="query.query_id"
              :label="query.query_id" /></ElSelect
          ><ElButton text aria-label="打开查询属性" @click="inspect(alias)"
            ><SlidersHorizontal :size="16" /></ElButton
          ><ElButton
            text
            @click="
              tab = 'parameters';
              inspector = true;
            "
            >参数</ElButton
          ><ElButton
            text
            @click="
              tab = 'presentation';
              inspector = true;
            "
            >展示</ElButton
          >
        </div>
        <ReportCanvas
          :editor="editor"
          :query-id="queryId"
          :ai-open="aiOpen"
          @add="
            adding = true;
            inspector = false;
            aiOpen = false;
          "
          @inspect="inspect"
          @ai="
            aiOpen = !aiOpen;
            inspector = false;
          "
        />
        <aside v-if="inspector" class="canvas-inspector canvas-floating">
          <header>
            <strong>{{
              tab === "queries" ? "查询属性" : tab === "parameters" ? "报表参数" : "展示配置"
            }}</strong
            ><ElButton text aria-label="关闭属性面板" @click="inspector = false"
              ><X :size="17"
            /></ElButton>
          </header>
          <fieldset :disabled="locked">
            <QueryEditor
              v-if="tab === 'queries' && queryId"
              :editor="editor"
              :query-id="queryId"
              :alias="alias"
              @relation="openRelation"
              @renamed="queryId = $event"
              @alias-selected="alias = $event"
            /><ParameterEditor
              v-else-if="tab === 'parameters'"
              :model-value="state.draft"
              @update:model-value="editor.update($event)"
              ><template #bindings="{ parameter }"
                ><ParameterBindings
                  :model-value="state.draft"
                  :parameter="parameter"
                  :datasets="state.datasets"
                  @update:model-value="editor.update($event)" /></template></ParameterEditor
            ><PresentationEditor v-else-if="tab === 'presentation'" :editor="editor" />
          </fieldset>
        </aside>
      </div>
    </template>
    <ReportRevision v-if="state.baseline" v-show="aiOpen" :save="save" @close="aiOpen = false" />
    <ElDrawer v-model="adding" title="添加查询" size="min(440px, 100vw)" destroy-on-close
      ><DatasetPicker :editor="editor" @added="added"
    /></ElDrawer>
    <ElDrawer
      :model-value="!!relation"
      title="批准关系"
      size="min(440px, 100vw)"
      destroy-on-close
      @close="relation = undefined"
      ><RelationPicker
        v-if="relation"
        :editor="editor"
        :query-id="queryId"
        :source-alias="relation.source"
        :target-alias="relation.target"
        @close="relation = undefined"
        @connected="
          alias = $event;
          relation = undefined;
        "
    /></ElDrawer>
  </section>
</template>
