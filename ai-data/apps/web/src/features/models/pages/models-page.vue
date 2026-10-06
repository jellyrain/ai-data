<script setup lang="ts">
import { vNumberAccessibility } from "../../../shared/management/number-accessibility";
import { computed, onMounted, ref } from "vue";
import { ElButton, ElInputNumber } from "element-plus";
import { stableStringify, type ModelConfiguration } from "@ai-data/contracts";
import ResourceList from "../../../shared/management/resource-list.vue";
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
const rows = computed(() =>
  items.value.map((item) => ({
    id: item.model_id,
    title: item.name,
    status: item.enabled ? "启用" : "停用",
    description: `v${item.version} · ${item.model}`,
  })),
);
function list() {
  return scope.run(async (request) => {
    items.value = await new ModelApi(request).list();
  });
}
async function open(id: string) {
  if (!(await discard())) return;
  await scope.run(async (request) => {
    const value = await new ModelApi(request).get(id);
    selected.value = value;
    latest.value = value;
    historyVersion.value = value.version;
    editing.value = false;
    draft.value = emptyModel();
    blocked.value = false;
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
function readVersion() {
  if (!selected.value) return;
  return scope.run(async (request) => {
    selected.value = await new ModelApi(request).get(
      selected.value!.model_id,
      historyVersion.value,
    );
  });
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
onMounted(list);
</script>
<template>
  <section class="management-page">
    <header class="management-heading">
      <div>
        <h1>模型管理</h1>
        <p class="muted">维护模型连接，按版本发布完整配置。</p>
      </div>
      <div class="management-actions">
        <ElButton :disabled="scope.state.busy" @click="list">刷新列表</ElButton
        ><ElButton type="primary" :disabled="scope.state.busy" @click="create">新建模型</ElButton>
      </div>
    </header>
    <ManagementFeedback v-bind="scope.state" />
    <div class="management-grid">
      <ResourceList
        :items="rows"
        :selected="selected?.model_id"
        :disabled="scope.state.busy"
        @select="open"
      />
      <main class="management-detail">
        <template v-if="editing"
          ><h2>{{ selected ? "发布新版本" : "新建模型" }}</h2>
          <ModelForm v-model="draft" :existing="!!selected" :disabled="scope.state.busy" />
          <footer class="management-footer">
            <ElButton
              type="primary"
              :loading="scope.state.busy"
              :disabled="blocked"
              @click="publish"
              >发布 v{{ draft.version }}</ElButton
            ><ElButton v-if="blocked" @click="rebase">核对后准备下一版本</ElButton
            ><ElButton
              :disabled="scope.state.busy"
              @click="
                async () => {
                  if (await discard()) {
                    editing = false;
                    draft = emptyModel();
                  }
                }
              "
              >取消编辑</ElButton
            >
          </footer></template
        >
        <template v-else-if="selected"
          ><h2>{{ selected.name }}</h2>
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
          <div class="management-footer">
            <ElButton type="primary" :disabled="scope.state.busy" @click="edit"
              >以此版本为基础发布</ElButton
            ><ElButton :disabled="scope.state.busy" @click="toggle">{{
              selected.enabled ? "停用模型" : "启用模型"
            }}</ElButton>
          </div></template
        >
        <div v-else class="management-empty">选择模型查看版本与连接配置，或新建模型。</div>
      </main>
    </div>
  </section>
</template>
