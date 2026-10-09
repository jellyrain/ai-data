<script setup lang="ts">
import { vNumberAccessibility } from "../../../shared/management/number-accessibility";
import { computed, onMounted, ref } from "vue";
import { ElButton, ElInputNumber, ElInput, ElSelect, ElOption } from "element-plus";
import {
  stableStringify,
  type AgentVersion,
  type AgentToolEntry,
  type SkillCatalogEntry,
  type ModelConfiguration,
} from "@ai-data/contracts";
import { AgentApi } from "../api/agent-api";
import { ModelApi } from "../../models/api/model-api";
import { emptyAgent, agentDraft } from "../stores/agent-draft";
import AgentForm from "../components/agent-form.vue";
import SkillPreview from "../components/skill-preview.vue";
import { ApiError } from "../../../shared/http/api-error";
import ResourceCard from "../../../shared/management/resource-card.vue";
import { useResourceLocation } from "../../../shared/management/use-resource-location";
import { Bot, ArrowLeft, Search } from "lucide-vue-next";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
const items = ref<AgentVersion[]>([]),
  selected = ref<AgentVersion | null>(null),
  latest = ref<AgentVersion | null>(null),
  models = ref<ModelConfiguration[]>([]),
  tools = ref<AgentToolEntry[]>([]),
  skills = ref<SkillCatalogEntry[]>([]);
const draft = ref(emptyAgent()),
  editing = ref(false),
  baseline = ref(""),
  historyVersion = ref(1),
  blocked = ref(false),
  preview = ref("");
const { scope, discard } = useManagementPage(
  () => {
    items.value = [];
    selected.value = null;
    latest.value = null;
    models.value = [];
    tools.value = [];
    skills.value = [];
    draft.value = emptyAgent();
    editing.value = false;
    baseline.value = "";
    blocked.value = false;
    preview.value = "";
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
      (item.name + " " + item.agent_id)
        .toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()),
  ),
);
function clearSelection() {
  selected.value = null;
  latest.value = null;
  draft.value = emptyAgent();
  editing.value = false;
  baseline.value = "";
  blocked.value = false;
  detailTab.value = "config";
  preview.value = "";
}
const location = useResourceLocation({ discard, clear: clearSelection, load: loadSelection });
async function open(id: string) {
  await location.select(id);
}
async function cancelEditing() {
  if (!(await discard())) return;
  editing.value = false;
  draft.value = emptyAgent();
  preview.value = "";
}
function list() {
  return scope.run(async (request) => {
    const api = new AgentApi(request);
    const loaded = await Promise.all([
      api.list(),
      api.tools(),
      api.skills(),
      new ModelApi(request).list(),
    ]);
    [items.value, tools.value, skills.value, models.value] = loaded;
  });
}
async function loadSelection(id: string, version?: number) {
  await scope.run(async (request) => {
    const api = new AgentApi(request);
    latest.value = await api.get(id);
    selected.value =
      version && version !== latest.value.version ? await api.get(id, version) : latest.value;
    historyVersion.value = selected.value.version;
  });
}
async function create() {
  if (!(await discard())) return;
  draft.value = emptyAgent();
  if (tools.value.some((t) => t.name === "get_tool_schema"))
    draft.value.tool_names = ["get_tool_schema"];
  selected.value = null;
  latest.value = null;
  editing.value = true;
  blocked.value = false;
  baseline.value = stableStringify(draft.value);
}
async function readVersion() {
  if (selected.value) await location.select(selected.value.agent_id, historyVersion.value);
}
async function edit() {
  if (!selected.value || !(await discard())) return;
  await scope.run(async (request) => {
    latest.value = await new AgentApi(request).get(selected.value!.agent_id);
    draft.value = agentDraft(selected.value!, latest.value.version + 1);
    baseline.value = stableStringify(draft.value);
    editing.value = true;
    blocked.value = false;
  });
}
async function publish() {
  await scope.run(async (request) => {
    const api = new AgentApi(request),
      result = await api.publish(draft.value);
    if (result.status === "saved" && result.current) {
      selected.value = result.current;
      latest.value = result.current;
      historyVersion.value = result.current.version;
      editing.value = false;
      draft.value = emptyAgent();
      items.value = await api.list();
      scope.state.notice = "Agent 已发布。新会话可选择此版本，既有会话保留原绑定。";
    } else {
      blocked.value = true;
      latest.value = result.current;
      scope.state.notice =
        result.status === "conflict"
          ? `版本发生变化，最新为 v${result.current?.version ?? 0}。草稿已保留。`
          : "发布结果待核对，请读取目标版本后决定下一次发布。";
    }
  });
  if (!editing.value && selected.value)
    await location.select(selected.value.agent_id, selected.value.version, true);
}
async function rebase() {
  if (!(await confirmManagement("重新读取最新版本，保留草稿并采用下一版本号。", "核对发布版本")))
    return;
  await scope.run(async (request) => {
    try {
      latest.value = await new AgentApi(request).get(draft.value.agent_id);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      latest.value = null;
    }
    draft.value.version = (latest.value?.version ?? 0) + 1;
    blocked.value = false;
  });
}
async function toggle() {
  const value = selected.value;
  if (
    !value ||
    !(await confirmManagement(
      `${value.enabled ? "停用后该 Agent 各版本不能开始新的运行；已在执行的运行继续处理" : "启用后该 Agent 可再次运行"}。`,
      `${value.enabled ? "停用" : "启用"} ${value.name}`,
    ))
  )
    return;
  await scope.run(async (request) => {
    const api = new AgentApi(request);
    try {
      await api.status(value.agent_id, !value.enabled);
    } catch (error) {
      selected.value = await api.get(value.agent_id, value.version);
      if (selected.value.enabled === value.enabled) throw error;
    }
    selected.value = await api.get(value.agent_id, value.version);
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
          aria-label="返回Agent列表"
          @click="location.close"
          ><ArrowLeft :size="19"
        /></ElButton>
        <div>
          <h1>{{ selected ? selected.name : editing ? "新建Agent" : "Agent 管理" }}</h1>
          <p class="muted">
            {{ selected ? selected.agent_id : "组合模型、工具与 Skill，管理分析助手。" }}
          </p>
        </div>
      </div>
      <div class="management-actions">
        <ElButton :disabled="scope.state.busy" @click="list">刷新资源</ElButton>
        <template v-if="editing">
          <ElButton :disabled="scope.state.busy" @click="cancelEditing">取消编辑</ElButton>
          <ElButton v-if="blocked" @click="rebase">核对后准备下一版本</ElButton>
          <ElButton type="primary" :loading="scope.state.busy" :disabled="blocked" @click="publish"
            >发布 v{{ draft.version }}</ElButton
          >
        </template>
        <template v-else-if="selected">
          <ElButton :disabled="scope.state.busy" @click="toggle">{{
            selected.enabled ? "停用 Agent" : "启用 Agent"
          }}</ElButton>
          <ElButton type="primary" :disabled="scope.state.busy" @click="edit"
            >以此版本为基础发布</ElButton
          >
        </template>
        <template v-else>
          <ElButton type="primary" :disabled="scope.state.busy" @click="create"
            >新建 Agent</ElButton
          >
        </template>
      </div>
    </header>
    <ManagementFeedback v-bind="scope.state" />
    <template v-if="!selected && !editing && !location.route.query.resource">
      <div class="management-browse-toolbar">
        <ElInput v-model="search" clearable aria-label="搜索Agent" placeholder="搜索名称或标识"
          ><template #prefix><Search :size="16" /></template
        ></ElInput>
        <ElSelect v-model="status" aria-label="Agent状态"
          ><ElOption label="全部状态" value="all" /><ElOption
            label="已启用"
            value="enabled" /><ElOption label="已停用" value="disabled"
        /></ElSelect>
        <span class="muted">当前 {{ visible.length }} 个Agent</span>
      </div>
      <div class="management-card-grid">
        <ResourceCard
          v-for="item in visible"
          :key="item.agent_id"
          :title="item.name"
          :identifier="item.agent_id"
          :status="item.enabled ? '启用' : '停用'"
          :active="item.enabled"
          :disabled="scope.state.busy"
          @select="open(item.agent_id)"
        >
          <template #icon><Bot :size="23" /></template>
          <span
            ><span>当前版本</span><span>v{{ item.version }}</span></span
          >
          <span
            ><span>固定模型</span><span>{{ item.model_id }} · v{{ item.model_version }}</span></span
          ><span
            ><span>Skill 资源</span><span>{{ item.skill_names.length }} 项</span></span
          >
        </ResourceCard>
      </div>
      <div v-if="!visible.length" class="management-empty">
        {{
          scope.state.busy
            ? "正在读取Agent…"
            : items.length
              ? "没有匹配的Agent"
              : "暂无Agent，点击右上角新建。"
        }}
      </div>
    </template>
    <template v-else>
      <nav v-if="selected && !editing" class="management-tabs" aria-label="Agent详情">
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
            <AgentForm
              v-model="draft"
              :existing="!!selected"
              :disabled="scope.state.busy"
              :models="models"
              :tools="tools"
              :skills="skills"
              @preview="preview = $event"
          /></template>
          <template v-else-if="selected">
            <template v-if="detailTab === 'history'">
              <h2>查看已发布版本</h2>
              <div class="management-toolbar">
                <label for="agent-history">查看版本</label
                ><ElInputNumber
                  id="agent-history"
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
              <dt>Agent 标识</dt>
              <dd>{{ selected.agent_id }}</dd>
              <dt>版本 / 状态</dt>
              <dd>v{{ selected.version }} · {{ selected.enabled ? "启用" : "停用" }}</dd>
              <dt>固定模型</dt>
              <dd>{{ selected.model_id }} · v{{ selected.model_version }}</dd>
              <dt>说明</dt>
              <dd>{{ selected.description || "—" }}</dd>
              <dt>运行指令/系统提示词</dt>
              <dd>{{ selected.instructions || "—" }}</dd>
              <dt>工具</dt>
              <dd>{{ selected.tool_names.join("、") || "无" }}</dd>
              <dt>Skill</dt>
              <dd>
                <ElButton
                  v-for="name in selected.skill_names"
                  :key="name"
                  text
                  @click="preview = name"
                  >{{ name }} · 源文档</ElButton
                >
              </dd>
              <dt>资源快照指纹</dt>
              <dd>{{ selected.skill_fingerprint }}</dd>
              <dt>超时 / 工具次数</dt>
              <dd>{{ selected.limits.timeout_ms }} ms / {{ selected.limits.max_tool_calls }}</dd>
              <dt>上下文预算</dt>
              <dd>
                {{ selected.limits.max_context_bytes }} 字节 /
                {{ selected.limits.context_window ?? "沿用模型窗口" }}
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
            <p class="management-help management-aside-note">
              新会话使用所选版本，已有会话保留原绑定。
            </p>
          </section>
          <section class="management-panel">
            <h2>版本管理</h2>
            <p class="management-help">已发布版本保留，配置变更将生成独立版本。</p>
          </section>
          <SkillPreview v-if="preview" :key="preview" :name="preview" />
        </aside>
      </div>
    </template>
  </section>
</template>
