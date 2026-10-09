<script setup lang="ts">
import { useRoute } from "vue-router";
import { computed, onMounted, ref } from "vue";
import { ElButton, ElInput, ElOption, ElSelect, ElSkeleton } from "element-plus";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  stableStringify,
  knowledgeCandidateInputSchema,
  type KnowledgeCandidate,
  type KnowledgeCandidateInput,
  type KnowledgeManagementRecord,
  type PublishedKnowledge,
  type KnowledgeOwnerOption,
  type KnowledgeSourceRecord,
  type KnowledgeReviewRecord,
  type ReportDefinitionVersion,
  type MetricDefinition,
  type MemorySource,
} from "@ai-data/contracts";
import { createUuid } from "../../../shared/identity/create-uuid";
import { useServices } from "../../../app/services";
import ResourceList from "../../../shared/management/resource-list.vue";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import { KnowledgeApi } from "../api/knowledge-api";
import { ApiError } from "../../../shared/http/api-error";
import ScopeEditor from "./scope-editor.vue";
import SourcePicker from "./source-picker.vue";
import MetricForm from "./metric-form.vue";
import KnowledgeContent from "./knowledge-content.vue";
dayjs.extend(utc);
const props = defineProps<{
  mode: "published" | "candidates" | "assigned" | "management";
  admin?: boolean;
}>();
const { auth } = useServices();
const route = useRoute();
const isAdmin = computed(() => auth.state.context?.roles.includes("system_admin") ?? false);
const isManager = computed(
  () => isAdmin.value || (auth.state.context?.permissions.includes("knowledge:manage") ?? false),
);
const candidates = ref<KnowledgeCandidate[]>([]),
  published = ref<PublishedKnowledge[]>([]),
  managed = ref<KnowledgeManagementRecord[]>([]),
  candidate = ref<KnowledgeCandidate | null>(null),
  record = ref<PublishedKnowledge | null>(null),
  head = ref<KnowledgeManagementRecord | null>(null),
  versions = ref<PublishedKnowledge[]>([]),
  reviews = ref<KnowledgeReviewRecord[]>([]),
  sources = ref<KnowledgeSourceRecord[]>([]),
  template = ref<ReportDefinitionVersion | null>(null),
  owners = ref<KnowledgeOwnerOption[]>([]);
const detailTab = ref("content");
const ownerSearch = ref(""),
  ownerId = ref(""),
  statusFilter = ref(""),
  typeFilter = ref(typeof route.query.type === "string" ? route.query.type : ""),
  ownerFilter = ref(""),
  comment = ref(""),
  effective = ref(""),
  editing = ref(false),
  baseline = ref(""),
  blocked = ref(false),
  supplemental = ref<MemorySource>({ evidence_ids: [] });
const fresh = (): KnowledgeCandidateInput => ({
  idempotency_key: createUuid(),
  content: { type: "business_rule", title: "", body: "" },
  scope: {},
  source: { evidence_ids: [] },
});
const draft = ref(fresh()),
  metricValid = ref(true);
let rollbackAttempt = { content: "", id: "" };
const { scope, discard } = useManagementPage(
  () => {
    candidates.value = [];
    published.value = [];
    managed.value = [];
    clearSelection();
    owners.value = [];
    draft.value = fresh();
    editing.value = false;
    baseline.value = "";
    ownerSearch.value = "";
    rollbackAttempt = { content: "", id: "" };
  },
  () => editing.value && stableStringify(draft.value) !== baseline.value,
);
const statuses: Record<string, string> = {
  pending: "待审核",
  approved: "审核通过",
  rejected: "已驳回",
  withdrawn: "已撤回",
  published: "已发布",
};
function title(content: KnowledgeCandidate["content"]) {
  return content.type === "business_rule"
    ? content.title
    : content.type === "metric"
      ? content.definition.name
      : "报表模板 · " + content.report_id;
}
const rows = computed(() => {
  const filter = (item: KnowledgeCandidate | PublishedKnowledge) =>
    (!typeFilter.value || item.content.type === typeFilter.value) &&
    (!ownerFilter.value || (item.owner_id ?? "").includes(ownerFilter.value));
  if (props.mode === "published")
    return published.value.filter(filter).map((item) => ({
      id: item.knowledge_id,
      title: title(item.content),
      description: "v" + item.version + " · " + item.effective_at,
      status: "已生效",
    }));
  if (props.mode === "management")
    return managed.value
      .filter((item) => filter(item.latest))
      .map((item) => ({
        id: item.knowledge_id,
        title: title(item.latest.content),
        description:
          "最新 v" +
          item.latest.version +
          (item.current ? " · 生效 v" + item.current.version : " · 暂无生效版本"),
        status: item.enabled ? "已启用" : "已停用",
      }));
  return candidates.value
    .filter(
      (item) =>
        filter(item) &&
        (!statusFilter.value || item.status === statusFilter.value) &&
        (props.mode !== "assigned" || item.owner_id === auth.state.context?.userId),
    )
    .map((item) => ({
      id: item.candidate_id,
      title: title(item.content),
      description: "v" + item.version + " · " + (item.owner_id ?? "待分配负责人"),
      status: statuses[item.status],
    }));
});
const content = computed(() => candidate.value?.content ?? record.value?.content);
const mayReview = computed(
  () =>
    !!candidate.value && (isAdmin.value || candidate.value.owner_id === auth.state.context?.userId),
);
const mayEdit = computed(
  () =>
    !!candidate.value &&
    (isAdmin.value || candidate.value.created_by === auth.state.context?.userId) &&
    !["published", "withdrawn"].includes(candidate.value.status),
);
const mayManage = computed(
  () =>
    !!head.value && (isAdmin.value || head.value.latest.owner_id === auth.state.context?.userId),
);
function clearSelection() {
  candidate.value = null;
  record.value = null;
  head.value = null;
  versions.value = [];
  reviews.value = [];
  sources.value = [];
  template.value = null;
  ownerId.value = "";
  comment.value = "";
  effective.value = dayjs().utcOffset(8).format("YYYY-MM-DD HH:mm:ss");
  blocked.value = false;
  supplemental.value = { evidence_ids: [] };
}
async function list(api: KnowledgeApi) {
  if (props.mode === "published") published.value = await api.published();
  else if (props.mode === "management") managed.value = await api.management();
  else candidates.value = await api.candidates(!!props.admin || props.mode === "assigned");
}
function load() {
  return scope.run(async (request) => list(new KnowledgeApi(request)));
}
async function detail(api: KnowledgeApi, id: string) {
  clearSelection();
  editing.value = false;
  if (props.mode === "published") {
    record.value = await api.getPublished(id);
    if (record.value?.content.type === "report_template") {
      const ref = record.value.content;
      template.value =
        (await api.templates()).find(
          (item) => item.report_id === ref.report_id && item.version === ref.definition_version,
        ) ?? null;
    }
  } else if (props.mode === "management") {
    head.value = await api.getManagement(id);
    record.value = head.value.latest;
    if (mayManage.value) versions.value = await api.versions(id);
  } else {
    candidate.value = await api.candidate(id);
    ownerId.value = candidate.value.owner_id ?? "";
    sources.value = await api.sources(id);
    reviews.value = await api.reviews(id);
    if (candidate.value.content.type === "report_template") template.value = await api.template(id);
  }
}
async function open(id: string) {
  if (!(await discard())) return;
  if (id !== (candidate.value?.candidate_id ?? record.value?.knowledge_id))
    detailTab.value = "content";
  await scope.run(async (request) => detail(new KnowledgeApi(request), id));
}
async function create() {
  if (!(await discard())) return;
  clearSelection();
  draft.value = fresh();
  baseline.value = stableStringify(draft.value);
  editing.value = true;
}
async function edit() {
  if (!candidate.value || !(await discard())) return;
  draft.value = {
    idempotency_key: createUuid(),
    knowledge_id: candidate.value.knowledge_id,
    content: JSON.parse(JSON.stringify(candidate.value.content)),
    scope: { ...candidate.value.scope },
    source: { evidence_ids: [] },
  };
  baseline.value = stableStringify(draft.value);
  editing.value = true;
}
async function revise() {
  if (!record.value || !(await discard())) return;
  const value = record.value;
  clearSelection();
  draft.value = {
    ...fresh(),
    knowledge_id: value.knowledge_id,
    content: JSON.parse(JSON.stringify(value.content)),
    scope: { ...value.scope },
  };
  if (draft.value.content.type === "metric") draft.value.content.definition.version++;
  baseline.value = stableStringify(draft.value);
  editing.value = true;
}
function changeKind(type: string) {
  if (type === "business_rule") draft.value.content = { type, title: "", body: "" };
  else if (type === "metric") {
    const definition: MetricDefinition = {
      metric_id: "",
      version: 1,
      name: "",
      description: "",
      aliases: [],
      grain: "",
      deduplication_keys: [],
      date_basis: { field: "", data_type: "date" },
      query: {
        type: "relational_query",
        source_id: "",
        from: { object_id: "", alias: "t" },
        joins: [],
        select: [],
        filters: { logic: "and", items: [] },
        group_by: [],
        order_by: [],
        limit: 1000,
      },
      dimensions: [],
      value: { type: "column", column: "" },
      total_rule: "recalculate",
    };
    draft.value.content = { type: "metric", definition };
  }
}
async function save() {
  await scope.run(async (request) => {
    const api = new KnowledgeApi(request),
      parsed = knowledgeCandidateInputSchema.parse(draft.value);
    try {
      const saved = candidate.value
        ? await api.update(candidate.value.candidate_id, {
            expected_version: candidate.value.version,
            content: parsed.content,
            scope: parsed.scope,
          })
        : await api.submit(parsed);
      candidate.value = saved;
      editing.value = false;
      await list(api);
      scope.state.notice = "候选已保存，修改内容需要按当前版本审核。";
    } catch (error) {
      if (error instanceof ApiError && ![401, 403, 400].includes(error.status))
        blocked.value = true;
      throw error;
    }
  });
}
async function searchOwners() {
  await scope.run(async (request) => {
    owners.value = await new KnowledgeApi(request).owners(ownerSearch.value);
  });
}
async function action(
  action: "withdraw" | "owner" | "review" | "publish",
  decision?: "approve" | "reject",
) {
  const value = candidate.value;
  if (!value) return;
  if (
    ["withdraw", "publish"].includes(action) &&
    !(await confirmManagement(
      action === "publish"
        ? "将发布当前审核通过的固定版本，按设置时间生效。"
        : "撤回后此候选将停止审核。",
      action === "publish" ? "发布知识" : "撤回候选",
    ))
  )
    return;
  await scope.run(async (request) => {
    const api = new KnowledgeApi(request),
      body = {
        expected_version: value.version,
        ...(action === "owner"
          ? { owner_id: ownerId.value }
          : action === "review"
            ? { decision, comment: comment.value }
            : action === "publish"
              ? { effective_at: effective.value }
              : {}),
      };
    try {
      await api.action(value.candidate_id, action, body);
      await detail(api, value.candidate_id);
      await list(api);
      scope.state.notice = "操作已保存。";
    } catch (error) {
      if (error instanceof ApiError && ![401, 403, 400].includes(error.status)) {
        blocked.value = true;
        scope.state.notice = "请重新读取候选，核对当前版本与上次操作结果。";
      }
      throw error;
    }
  });
}
async function support() {
  if (!candidate.value) return;
  await scope.run(async (request) => {
    const api = new KnowledgeApi(request);
    await api.support(candidate.value!.candidate_id, supplemental.value);
    sources.value = await api.sources(candidate.value!.candidate_id);
    scope.state.notice = "来源已补充。";
  });
}
async function toggle() {
  const item = head.value;
  if (
    !item ||
    !(await confirmManagement(
      item.enabled
        ? "停用后，后续运行将不再使用此知识。"
        : "启用后，已到生效时间的版本可再次使用。",
      item.enabled ? "停用知识" : "启用知识",
    ))
  )
    return;
  await scope.run(async (request) => {
    const api = new KnowledgeApi(request);
    try {
      await api.enabled(item.knowledge_id, !item.enabled);
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
      const fresh = await api.getManagement(item.knowledge_id);
      if (fresh.enabled === item.enabled) throw error;
    }
    await detail(api, item.knowledge_id);
    await list(api);
  });
}
async function rollback() {
  const value = record.value,
    item = head.value;
  if (
    !value ||
    !item ||
    !(await confirmManagement("将以选中历史内容创建新的发布版本，并启用该知识。", "回滚知识版本"))
  )
    return;
  await scope.run(async (request) => {
    const api = new KnowledgeApi(request);
    const payload = {
      version: value.version,
      expected_version: item.latest.version,
      effective_at: effective.value,
    };
    const content = stableStringify(payload);
    if (rollbackAttempt.content !== content) rollbackAttempt = { content, id: createUuid() };
    try {
      await api.rollback(item.knowledge_id, { ...payload, idempotency_key: rollbackAttempt.id });
      await detail(api, item.knowledge_id);
      await list(api);
    } catch (error) {
      if (error instanceof ApiError && ![401, 403, 400].includes(error.status))
        blocked.value = true;
      throw error;
    }
  });
}
onMounted(async () => {
  await load();
  if (props.mode === "candidates" && typeof route.query.candidate === "string")
    await open(route.query.candidate);
});
defineExpose({ discard, busy: computed(() => scope.state.busy) });
</script>
<template>
  <div class="management-toolbar" :class="{ 'management-context-bar': admin }">
    <ElButton
      v-if="mode === 'candidates'"
      type="primary"
      :disabled="scope.state.busy"
      @click="create"
      >提交知识候选</ElButton
    ><ElButton :loading="scope.state.busy" @click="load">刷新列表</ElButton
    ><ElSelect v-model="typeFilter" aria-label="知识类型" placeholder="全部类型"
      ><ElOption value="" label="全部类型" /><ElOption
        value="business_rule"
        label="业务规则" /><ElOption value="metric" label="指标" /><ElOption
        value="report_template"
        label="报表模板" /></ElSelect
    ><ElSelect
      v-if="['candidates', 'assigned'].includes(mode)"
      v-model="statusFilter"
      aria-label="候选状态"
      placeholder="全部状态"
      ><ElOption value="" label="全部状态" /><ElOption
        v-for="(label, value) in statuses"
        :key="value"
        :value="value"
        :label="label" /></ElSelect
    ><ElInput v-model="ownerFilter" placeholder="筛选负责人标识" aria-label="筛选负责人" /><span
      class="muted"
      >本次返回
      {{
        mode === "published"
          ? published.length
          : mode === "management"
            ? managed.length
            : candidates.length
      }}
      条</span
    >
  </div>
  <ManagementFeedback v-bind="scope.state" /><ElSkeleton
    v-if="scope.state.busy && !rows.length && !editing"
    :rows="5"
  />
  <div class="management-grid">
    <ResourceList
      :items="rows"
      :selected="candidate?.candidate_id ?? record?.knowledge_id"
      :disabled="scope.state.busy"
      @select="open"
    />
    <div class="management-detail">
      <template v-if="editing"
        ><h2>{{ candidate ? "修改候选" : "提交知识候选" }}</h2>
        <fieldset class="knowledge-fieldset" :disabled="scope.state.busy || blocked">
          <label v-if="!candidate && !draft.knowledge_id"
            >类型<ElSelect
              :model-value="draft.content.type"
              aria-label="候选类型"
              @update:model-value="changeKind(String($event))"
              ><ElOption value="business_rule" label="业务规则" /><ElOption
                value="metric"
                label="指标" /></ElSelect></label
          ><template v-if="draft.content.type === 'business_rule'"
            ><label
              >标题<ElInput
                v-model="draft.content.title"
                maxlength="256"
                aria-label="知识标题" /></label
            ><label
              >规则正文<ElInput
                v-model="draft.content.body"
                type="textarea"
                :rows="8"
                maxlength="16000"
                aria-label="知识正文"
            /></label>
            <details>
              <summary>预览正文</summary>
              <KnowledgeContent :content="draft.content" /></details></template
          ><MetricForm
            v-else-if="draft.content.type === 'metric'"
            v-model="draft.content.definition"
            @valid="metricValid = $event"
          /><KnowledgeContent v-else :content="draft.content" />
          <section class="management-section">
            <h3>适用范围</h3>
            <ScopeEditor v-model="draft.scope" />
          </section>
          <section v-if="!candidate" class="management-section">
            <h3>内容来源</h3>
            <SourcePicker
              :model-value="draft.source ?? { evidence_ids: [] }"
              @update:model-value="draft.source = $event"
            />
          </section>
        </fieldset>
        <div class="management-footer">
          <ElButton
            type="primary"
            :loading="scope.state.busy"
            :disabled="blocked || (draft.content.type === 'metric' && !metricValid)"
            @click="save"
            >保存候选</ElButton
          ><ElButton v-if="blocked && candidate" @click="open(candidate.candidate_id)"
            >重新读取候选</ElButton
          ><ElButton v-if="blocked && !candidate" @click="blocked = false"
            >保留操作标识后重试</ElButton
          >
        </div></template
      >
      <template v-else-if="content"
        ><h2>{{ template?.definition.title ?? title(content) }}</h2>
        <p class="management-help">
          {{
            candidate
              ? statuses[candidate.status]
              : head
                ? head.enabled
                  ? "已启用"
                  : "已停用"
                : "已生效"
          }}
          · v{{ candidate?.version ?? record?.version }} · 负责人
          {{ candidate?.owner_id ?? record?.owner_id ?? "待分配" }}
        </p>
        <p v-if="record" class="management-help">生效时间（东八区）：{{ record.effective_at }}</p>
        <p class="management-help">
          适用范围：{{
            Object.values(candidate?.scope ?? record?.scope ?? {}).join(" / ") || "通用"
          }}
        </p>
        <nav
          v-if="admin && candidate"
          class="management-tabs knowledge-review-tabs"
          aria-label="审核详情"
        >
          <ElButton
            :type="detailTab === 'content' ? 'primary' : 'default'"
            @click="detailTab = 'content'"
            >知识内容</ElButton
          >
          <ElButton
            :type="detailTab === 'review' ? 'primary' : 'default'"
            @click="detailTab = 'review'"
            >负责人和审核</ElButton
          >
          <ElButton
            :type="detailTab === 'history' ? 'primary' : 'default'"
            @click="detailTab = 'history'"
            >来源与记录</ElButton
          >
        </nav>
        <div v-show="!admin || !candidate || detailTab === 'content'">
          <KnowledgeContent :content="content" :template="template" :show-heading="false" />
        </div>
        <div v-show="!admin || !candidate || detailTab === 'content'" class="management-actions">
          <ElButton v-if="mayEdit" :disabled="scope.state.busy || blocked" @click="edit"
            >修改候选</ElButton
          ><ElButton
            v-if="mayEdit"
            :disabled="scope.state.busy || blocked"
            @click="action('withdraw')"
            >撤回候选</ElButton
          ><ElButton
            v-if="record && content.type !== 'report_template'"
            :disabled="scope.state.busy"
            @click="revise"
            >提交修订候选</ElButton
          ><RouterLink
            v-if="mode === 'published' && template"
            :to="{
              path: '/reports/new',
              query: { template: template.report_id, version: template.version },
            }"
            >使用模板新建报表</RouterLink
          ><ElButton v-if="blocked && candidate" @click="open(candidate.candidate_id)"
            >重新读取候选</ElButton
          ><ElButton v-if="blocked && head" @click="open(head.knowledge_id)">核对发布版本</ElButton>
        </div>
        <template v-if="candidate"
          ><div v-show="!admin || detailTab === 'review'" class="knowledge-review-controls">
            <section
              v-if="isManager && !['published', 'withdrawn'].includes(candidate.status)"
              class="management-section"
            >
              <h3>分配负责人</h3>
              <div class="management-toolbar">
                <ElInput
                  v-model="ownerSearch"
                  aria-label="搜索负责人"
                  placeholder="姓名或账号"
                /><ElButton :disabled="scope.state.busy" @click="searchOwners">搜索负责人</ElButton>
              </div>
              <ElSelect v-model="ownerId" filterable aria-label="负责人"
                ><ElOption
                  v-for="item in owners"
                  :key="item.user_id"
                  :value="item.user_id"
                  :label="item.display_name + ' · ' + item.username" /></ElSelect
              ><ElButton
                :disabled="!ownerId || scope.state.busy || blocked"
                @click="action('owner')"
                >分配负责人</ElButton
              >
              <p class="management-help">分配后候选进入待审状态；负责人须已有相关数据访问权限。</p>
            </section>
            <section v-if="mayReview && candidate.status === 'pending'" class="management-section">
              <h3>审核当前版本</h3>
              <ElInput
                v-model="comment"
                type="textarea"
                :rows="3"
                maxlength="2000"
                placeholder="填写审核意见"
                aria-label="审核意见"
              />
              <div class="management-actions">
                <ElButton
                  type="primary"
                  :disabled="!comment.trim() || scope.state.busy || blocked"
                  @click="action('review', 'approve')"
                  >审核通过</ElButton
                ><ElButton
                  :disabled="!comment.trim() || scope.state.busy || blocked"
                  @click="action('review', 'reject')"
                  >驳回</ElButton
                >
              </div>
            </section>
            <section v-if="mayReview && candidate.status === 'approved'" class="management-section">
              <h3>发布</h3>
              <label
                >生效时间（东八区）<ElInput
                  v-model="effective"
                  aria-label="知识生效时间"
                  placeholder="YYYY-MM-DD HH:mm:ss" /></label
              ><ElButton
                type="primary"
                :disabled="scope.state.busy || blocked"
                @click="action('publish')"
                >发布知识</ElButton
              >
            </section>
            <p v-if="admin && !mayReview && !isManager" class="management-help">
              审核由指定负责人处理。
            </p>
          </div>
          <div v-show="!admin || detailTab === 'history'">
            <section class="management-section">
              <h3>来源与支持</h3>
              <p v-if="!sources.length" class="muted">暂无当前可读来源。</p>
              <div v-for="(item, index) in sources" :key="index" class="knowledge-source">
                <span>{{ item.user_id }}</span
                ><RouterLink
                  v-if="item.user_id === auth.state.context?.userId && item.source.conversation_id"
                  :to="'/analysis/' + encodeURIComponent(item.source.conversation_id)"
                  >打开来源会话</RouterLink
                >
                <p class="management-help">
                  {{
                    item.source.analysis_run_id ? "运行 " + item.source.analysis_run_id : "手动提交"
                  }}
                  · {{ item.source.evidence_ids.length }} 条证据
                </p>
              </div>
              <details v-if="candidate.status !== 'withdrawn'">
                <summary>补充来源</summary>
                <SourcePicker v-model="supplemental" /><ElButton
                  :disabled="scope.state.busy || blocked"
                  @click="support"
                  >保存来源</ElButton
                >
              </details>
            </section>
            <section class="management-section">
              <h3>审核记录</h3>
              <p v-if="!reviews.length" class="muted">尚无审核记录。</p>
              <article v-for="review in reviews" :key="review.review_id" class="knowledge-review">
                <p>
                  v{{ review.candidate.version }} ·
                  {{ review.decision === "approve" ? "通过" : "驳回" }} · {{ review.reviewed_by }} ·
                  {{ review.reviewed_at }}
                </p>
                <p>{{ review.comment }}</p>
                <details>
                  <summary>当时审核的内容</summary>
                  <KnowledgeContent :content="review.candidate.content" />
                </details>
              </article>
            </section></div
        ></template>
        <section v-if="head" class="management-section">
          <h3>版本管理</h3>
          <p>
            最新发布 v{{ head.latest.version }} ·
            {{ head.current ? "当前生效 v" + head.current.version : "暂无生效版本" }}
          </p>
          <template v-if="mayManage"
            ><ElSelect
              :model-value="record?.version"
              aria-label="知识历史版本"
              @update:model-value="
                record = versions.find((item) => item.version === $event) ?? null
              "
              ><ElOption
                v-for="item in versions"
                :key="item.version"
                :value="item.version"
                :label="'v' + item.version + ' · ' + item.effective_at" /></ElSelect
            ><label
              >回滚生效时间（东八区）<ElInput v-model="effective" aria-label="回滚生效时间"
            /></label>
            <div class="management-actions">
              <ElButton :disabled="scope.state.busy || blocked" @click="toggle">{{
                head.enabled ? "停用知识" : "启用知识"
              }}</ElButton
              ><ElButton
                :disabled="scope.state.busy || blocked || record?.version === head.latest.version"
                @click="rollback"
                >以选中版本回滚</ElButton
              >
            </div></template
          >
          <p v-else class="management-help">启停与回滚由指定负责人或系统管理员执行。</p>
        </section>
      </template>
      <div v-else class="report-empty">
        <h2>{{ mode === "published" ? "团队共同认可的业务口径" : "选择记录查看内容" }}</h2>
        <p class="muted">
          {{
            mode === "published"
              ? "已审核发布并生效的规则、指标和模板会显示在这里。"
              : "审核始终绑定当前内容版本，修改后需要重新审核。"
          }}
        </p>
      </div>
    </div>
  </div>
</template>
