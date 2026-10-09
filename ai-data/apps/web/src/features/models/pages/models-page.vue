<script setup lang="ts">
import { vNumberAccessibility } from "../../../shared/management/number-accessibility";
import { computed, onMounted, ref } from "vue";
import { ElButton, ElInputNumber, ElInput, ElSelect, ElOption } from "element-plus";
import { stableStringify, type ModelConfiguration } from "@ai-data/contracts";
import ResourceCard from "../../../shared/management/resource-card.vue";
import { useResourceLocation } from "../../../shared/management/use-resource-location";
import { Cpu, ArrowLeft, Search } from "lucide-vue-next";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import { ModelApi } from "../api/model-api";
import { emptyModel, modelDraft, modelInput } from "../stores/model-draft";
import ModelForm from "../components/model-form.vue";
import { ApiError } from "../../../shared/http/api-error";
const items = ref<ModelConfiguration[]>([]),
  selected = ref<ModelConfiguration | null>(null),
  latest = ref<ModelConfiguration | null>(null);
const draft = ref(emptyModel()),
  editing = ref(false),
  baseline = ref(""),
  historyVersion = ref(1),
  blocked = ref(false);
const { scope, discard } = useManagementPage(
  () => {
    items.value = [];
    selected.value = null;
    latest.value = null;
    draft.value = emptyModel();
    editing.value = false;
    baseline.value = "";
    blocked.value = false;
  },
  () => editing.value && stableStringify(draft.value) !== baseline.value,
);
const search = ref(""),
  status = ref("all"),
  detailTab = ref("config");
const visible = computed(() =>
  items.value.filter(
    (item) =>
      (status.value === "all" || item.enabled === (status.value === "enabled")) &&
      (item.name + " " + item.model_id)
        .toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()),
  ),
);
function clearSelection() {
  selected.value = null;
  latest.value = null;
  draft.value = emptyModel();
  editing.value = false;
  baseline.value = "";
  blocked.value = false;
  detailTab.value = "config";
}
const location = useResourceLocation({ discard, clear: clearSelection, load: loadSelection });
async function open(id: string) {
  await location.select(id);
}
async function cancelEditing() {
  if (!(await discard())) return;
  editing.value = false;
  draft.value = emptyModel();
}
function list() {
  return scope.run(async (request) => {
    items.value = await new ModelApi(request).list();
  });
}
async function loadSelection(id: string, version?: number) {
  await scope.run(async (request) => {
    const api = new ModelApi(request);
    latest.value = await api.get(id);
    selected.value =
      version && version !== latest.value.version ? await api.get(id, version) : latest.value;
    historyVersion.value = selected.value.version;
  });
}
async function create() {
  if (!(await discard())) return;
  selected.value = null;
  latest.value = null;
  draft.value = emptyModel();
  baseline.value = stableStringify(draft.value);
  editing.value = true;
  blocked.value = false;
}
async function readVersion() {
  if (selected.value) await location.select(selected.value.model_id, historyVersion.value);
}
async function edit() {
  if (!selected.value || !(await discard())) return;
  await scope.run(async (request) => {
    latest.value = await new ModelApi(request).get(selected.value!.model_id);
    draft.value = modelDraft(selected.value!, latest.value.version + 1);
    baseline.value = stableStringify(draft.value);
    editing.value = true;
    blocked.value = false;
  });
}
async function publish() {
  await scope.run(async (request) => {
    const api = new ModelApi(request),
      result = await api.publish(modelInput(draft.value));
    if (result.status === "saved" && result.current) {
      selected.value = result.current;
      latest.value = result.current;
      historyVersion.value = result.current.version;
      draft.value = emptyModel();
      editing.value = false;
      items.value = await api.list();
      scope.state.notice = "模型版本已发布。新 Agent 可绑定此版本。";
    } else {
      blocked.value = true;
      latest.value = result.current;
      scope.state.notice =
        result.status === "conflict"
          ? `版本已变化，当前最新为 v${result.current?.version ?? 0}。草稿已保留。`
          : "发布结果待核对。公开配置无法核实认证内容，请检查目标版本后决定是否发布下一版本。";
    }
  });
  if (!editing.value && selected.value)
    await location.select(selected.value.model_id, selected.value.version, true);
}
async function rebase() {
  if (
    !(await confirmManagement(
      "将重新读取当前最新版本，保留表单内容，并把发布目标改为下一版本。请确认已核对上次发布结果。",
      "核对发布版本",
    ))
  )
    return;
  await scope.run(async (request) => {
    try {
      latest.value = await new ModelApi(request).get(draft.value.model_id);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      latest.value = null;
    }
    draft.value.version = (latest.value?.version ?? 0) + 1;
    blocked.value = false;
    scope.state.notice = "草稿已采用新版本号，请核对认证后发布。";
    draft.value.authentication_confirmed = false;
  });
}
async function toggle() {
  const value = selected.value;
  if (
    !value ||
    !(await confirmManagement(
      `${value.enabled ? "停用后，绑定该模型任一版本的后续运行将不可用" : "启用后，绑定该模型的 Agent 可再次运行"}。`,
      `${value.enabled ? "停用" : "启用"} ${value.name}`,
    ))
  )
    return;
  await scope.run(async (request) => {
    const api = new ModelApi(request);
    try {
      await api.status(value.model_id, !value.enabled);
    } catch (error) {
      const current = await api.get(value.model_id, value.version);
      selected.value = current;
      if (current.enabled === value.enabled) throw error;
    }
    selected.value = await api.get(value.model_id, value.version);
    items.value = await api.list();
  });
}
onMounted(async () => {
  await list();
  await location.restore();
});
</script>
<template>
  <section class="management-page management-resource-page">
    <header class="management-heading">
      <div class="management-title-group">
        <ElButton
          v-if="selected || editing || location.route.query.resource"
          text
          :disabled="scope.state.busy"
          aria-label="返回模型列表"
          @click="location.close"
          ><ArrowLeft :size="19"
        /></ElButton>
        <div>
          <h1>{{ selected ? selected.name : editing ? "新建模型" : "模型管理" }}</h1>
          <p class="muted">{{ selected ? selected.model_id : "配置模型服务，管理发布版本。" }}</p>
        </div>
      </div>
      <div class="management-actions">
        <ElButton :disabled="scope.state.busy" @click="list">刷新列表</ElButton>
        <template v-if="editing">
          <ElButton :disabled="scope.state.busy" @click="cancelEditing">取消编辑</ElButton>
          <ElButton v-if="blocked" @click="rebase">核对后准备下一版本</ElButton>
          <ElButton type="primary" :loading="scope.state.busy" :disabled="blocked" @click="publish"
            >发布 v{{ draft.version }}</ElButton
          >
        </template>
        <template v-else-if="selected">
          <ElButton :disabled="scope.state.busy" @click="toggle">{{
            selected.enabled ? "停用模型" : "启用模型"
          }}</ElButton>
          <ElButton type="primary" :disabled="scope.state.busy" @click="edit"
            >以此版本为基础发布</ElButton
          >
        </template>
        <template v-else>
          <ElButton type="primary" :disabled="scope.state.busy" @click="create">新建模型</ElButton>
        </template>
      </div>
    </header>
    <ManagementFeedback v-bind="scope.state" />
    <template v-if="!selected && !editing && !location.route.query.resource">
      <div class="management-browse-toolbar">
        <ElInput v-model="search" clearable aria-label="搜索模型" placeholder="搜索名称或标识"
          ><template #prefix><Search :size="16" /></template
        ></ElInput>
        <ElSelect v-model="status" aria-label="模型状态"
          ><ElOption label="全部状态" value="all" /><ElOption
            label="已启用"
            value="enabled" /><ElOption label="已停用" value="disabled"
        /></ElSelect>
        <span class="muted">当前 {{ visible.length }} 个模型</span>
      </div>
      <div class="management-card-grid">
        <ResourceCard
          v-for="item in visible"
          :key="item.model_id"
          :title="item.name"
          :identifier="item.model_id"
          :status="item.enabled ? '启用' : '停用'"
          :active="item.enabled"
          :disabled="scope.state.busy"
          @select="open(item.model_id)"
        >
          <template #icon><Cpu :size="23" /></template>
          <span
            ><span>当前版本</span><span>v{{ item.version }}</span></span
          >
          <span
            ><span>上游模型</span><span>{{ item.model }}</span></span
          ><span
            ><span>上下文窗口</span
            ><span>{{
              item.context_window ? item.context_window.toLocaleString() + " tokens" : "运行时探测"
            }}</span></span
          >
        </ResourceCard>
      </div>
      <div v-if="!visible.length" class="management-empty">
        {{
          scope.state.busy
            ? "正在读取模型…"
            : items.length
              ? "没有匹配的模型"
              : "暂无模型，点击右上角新建。"
        }}
      </div>
    </template>
    <template v-else>
      <nav v-if="selected && !editing" class="management-tabs" aria-label="模型详情">
        <ElButton
          :type="detailTab === 'config' ? 'primary' : 'default'"
          @click="detailTab = 'config'"
          >配置详情</ElButton
        >
        <ElButton
          :type="detailTab === 'history' ? 'primary' : 'default'"
          @click="detailTab = 'history'"
          >版本记录</ElButton
        >
      </nav>
      <div class="management-editor-layout">
        <main class="management-panel management-editor-main">
          <template v-if="editing"
            ><h2>基本配置</h2>
            <ModelForm v-model="draft" :existing="!!selected" :disabled="scope.state.busy"
          /></template>
          <template v-else-if="selected">
            <template v-if="detailTab === 'history'">
              <h2>查看已发布版本</h2>
              <div class="management-toolbar">
                <label for="model-history">查看版本</label
                ><ElInputNumber
                  id="model-history"
                  v-model="historyVersion"
                  v-number-accessibility
                  :min="1"
                  :max="latest?.version ?? 1"
                  :precision="0"
                  style="max-width: 140px"
                /><ElButton :disabled="scope.state.busy" @click="readVersion">读取版本</ElButton>
              </div>
            </template>
            <h2 v-else>配置详情</h2>
            <dl class="management-definition">
              <dt>模型标识</dt>
              <dd>{{ selected.model_id }}</dd>
              <dt>版本 / 状态</dt>
              <dd>v{{ selected.version }} · {{ selected.enabled ? "启用" : "停用" }}</dd>
              <dt>协议</dt>
              <dd>Responses</dd>
              <dt>服务地址</dt>
              <dd>{{ selected.base_url }}</dd>
              <dt>上游模型</dt>
              <dd>{{ selected.model }}</dd>
              <dt>上下文窗口</dt>
              <dd>{{ selected.context_window ?? "运行时探测" }}</dd>
              <dt>认证配置</dt>
              <dd>
                {{ selected.has_api_key ? "已设置 API Key" : "未设置 API Key" }}<br />请求头：{{
                  selected.header_names.join("、") || "无"
                }}
              </dd>
            </dl>
          </template>
          <div v-else class="management-empty">
            {{ scope.state.busy ? "正在读取配置…" : "无法读取该资源，请返回列表重新选择。" }}
          </div>
        </main>
        <aside class="management-editor-aside">
          <section class="management-panel">
            <h2>{{ editing ? "本次发布" : "版本信息" }}</h2>
            <dl class="management-definition management-summary">
              <dt>当前版本</dt>
              <dd>{{ latest ? "v" + latest.version : "首次发布" }}</dd>
              <template v-if="editing"
                ><dt>待发布版本</dt>
                <dd>v{{ draft.version }}</dd></template
              >
              <template v-else-if="selected"
                ><dt>查看版本</dt>
                <dd>v{{ selected.version }}</dd></template
              >
              <dt>状态</dt>
              <dd>{{ selected ? (selected.enabled ? "已启用" : "已停用") : "待发布" }}</dd>
            </dl>
            <p class="management-help management-aside-note">发布后可供 Agent 选择使用。</p>
          </section>
          <section class="management-panel">
            <h2>版本管理</h2>
            <p class="management-help">已发布版本保留，配置变更将生成独立版本。</p>
          </section>
        </aside>
      </div>
    </template>
  </section>
</template>
