<script setup lang="ts">
import { vNumberAccessibility } from "../../../shared/management/number-accessibility";
import { computed, onMounted, ref } from "vue";
import { ElButton, ElInputNumber } from "element-plus";
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
import ResourceList from "../../../shared/management/resource-list.vue";
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
const rows = computed(() =>
  items.value.map((item) => ({
    id: item.agent_id,
    title: item.name,
    status: item.enabled ? "启用" : "停用",
    description: `v${item.version} · ${item.model_id} v${item.model_version}`,
  })),
);
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
async function open(id: string) {
  if (!(await discard())) return;
  await scope.run(async (request) => {
    selected.value = await new AgentApi(request).get(id);
    latest.value = selected.value;
    historyVersion.value = selected.value.version;
    editing.value = false;
    draft.value = emptyAgent();
    preview.value = "";
    blocked.value = false;
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
function readVersion() {
  if (!selected.value) return;
  return scope.run(async (request) => {
    selected.value = await new AgentApi(request).get(
      selected.value!.agent_id,
      historyVersion.value,
    );
  });
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
function publish() {
  return scope.run(async (request) => {
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
onMounted(list);
</script>
<template>
  <section class="management-page">
    <header class="management-heading">
      <div>
        <h1>Agent 管理</h1>
        <p class="muted">组合模型、工具与 Skill，发布可追溯的分析助手。</p>
      </div>
      <div class="management-actions">
        <ElButton :disabled="scope.state.busy" @click="list">刷新资源</ElButton
        ><ElButton type="primary" :disabled="scope.state.busy" @click="create">新建 Agent</ElButton>
      </div>
    </header>
    <ManagementFeedback v-bind="scope.state" />
    <div class="management-grid">
      <ResourceList
        :items="rows"
        :selected="selected?.agent_id"
        :disabled="scope.state.busy"
        @select="open"
      />
      <main class="management-detail">
        <template v-if="editing"
          ><h2>{{ selected ? "发布新版本" : "新建 Agent" }} · v{{ draft.version }}</h2>
          <AgentForm
            v-model="draft"
            :existing="!!selected"
            :disabled="scope.state.busy"
            :models="models"
            :tools="tools"
            :skills="skills"
            @preview="preview = $event"
          />
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
                    draft = emptyAgent();
                    preview = '';
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
          <dl class="management-definition">
            <dt>Agent 标识</dt>
            <dd>{{ selected.agent_id }}</dd>
            <dt>版本 / 状态</dt>
            <dd>v{{ selected.version }} · {{ selected.enabled ? "启用" : "停用" }}</dd>
            <dt>固定模型</dt>
            <dd>{{ selected.model_id }} · v{{ selected.model_version }}</dd>
            <dt>说明</dt>
            <dd>{{ selected.description || "—" }}</dd>
            <dt>运行指令</dt>
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
          <div class="management-footer">
            <ElButton type="primary" :disabled="scope.state.busy" @click="edit"
              >以此版本为基础发布</ElButton
            ><ElButton :disabled="scope.state.busy" @click="toggle">{{
              selected.enabled ? "停用 Agent" : "启用 Agent"
            }}</ElButton>
          </div></template
        >
        <div v-else class="management-empty">选择 Agent 查看版本配置，或新建分析助手。</div>
        <SkillPreview v-if="preview" :key="preview" :name="preview" />
      </main>
    </div>
  </section>
</template>
