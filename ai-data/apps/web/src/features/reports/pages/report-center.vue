<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  ElButton,
  ElInput,
  ElSkeleton,
  ElSelect,
  ElOption,
  ElDropdown,
  ElDropdownMenu,
  ElDropdownItem,
} from "element-plus";
import {
  Search,
  Files,
  ChartLine,
  ChartColumn,
  ChartPie,
  Table2,
  Ellipsis,
  Plus,
} from "lucide-vue-next";
import { useServices } from "../../../app/services";
import ReportMetadataEditor from "../components/report-metadata-editor.vue";
const { reports, auth } = useServices();
const state = reports.state;
const search = ref("");
const sort = ref("updated"),
  editing = ref("");
const typeLabels = {
  table: "明细表",
  line: "折线图",
  bar: "柱状图",
  pie: "饼图",
  legacy: "历史报表",
};
const typeIcons = {
  table: Table2,
  line: ChartLine,
  bar: ChartColumn,
  pie: ChartPie,
  legacy: Files,
};
const items = computed(() =>
  state.items
    .filter((item) =>
      item.title.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()),
    )
    .sort((a, b) =>
      sort.value === "name"
        ? a.title.localeCompare(b.title, "zh-CN")
        : (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at),
    ),
);
onMounted(() => {
  void reports.list();
});
onBeforeUnmount(() => reports.leave());
</script>
<template>
  <section class="report-center">
    <header class="report-page-heading">
      <div>
        <h1>报表中心</h1>
        <p class="muted">保存常用报表，随时查看和运行。</p>
      </div>
      <div class="report-heading-actions">
        <ElButton :loading="state.listing" @click="reports.list()">刷新列表</ElButton
        ><ElButton @click="$router.push({ path: '/knowledge', query: { type: 'report_template' } })"
          >组织模板</ElButton
        ><ElButton type="primary" @click="$router.push('/reports/new')"
          ><Plus :size="16" />新建报表</ElButton
        >
      </div>
    </header>
    <div class="report-search">
      <ElInput v-model="search" placeholder="筛选已加载报表" aria-label="筛选已加载报表" clearable
        ><template #prefix><Search :size="16" /></template></ElInput
      ><span class="muted">已加载 {{ state.items.length }} 份</span
      ><ElSelect v-model="sort" aria-label="已加载报表排序" class="report-sort"
        ><ElOption label="最近更新" value="updated" /><ElOption label="名称排序" value="name"
      /></ElSelect>
    </div>
    <p v-if="state.listError" role="alert" class="inline-error">
      {{ state.listError
      }}<ElButton text @click="reports.list(!!state.items.length)">重试读取列表</ElButton>
    </p>
    <ElSkeleton
      v-if="state.listing && !state.items.length"
      :rows="6"
      animated
      aria-label="正在读取报表"
    />
    <div v-else-if="!items.length && !state.listError" class="report-empty">
      <Files :size="32" :stroke-width="1.4" />
      <h2>{{ search ? "没有匹配的已加载报表" : "还没有可查看的报表" }}</h2>
      <p class="muted">
        {{
          search
            ? "试试其他标题，或加载更多报表。"
            : "保存的报表和你有权查看的共享报表会显示在这里。"
        }}
      </p>
    </div>
    <div class="report-card-grid">
      <article v-for="item in items" :key="item.report_id" class="report-card">
        <RouterLink
          class="report-row report-card-link"
          :to="`/reports/${encodeURIComponent(item.report_id)}`"
        >
          <div class="report-card-type">
            <component
              :is="typeIcons[item.display_type ?? 'legacy']"
              :size="20"
              :stroke-width="1.6"
              class="report-type-icon"
            />
            <span>{{ typeLabels[item.display_type ?? "legacy"] }}</span>
          </div>
          <div class="report-card-copy">
            <h2>{{ item.title }}</h2>
            <p class="muted">
              {{
                item.description ||
                (item.definition_version ? "按条件查询与查看结果" : "查看已保存的结果")
              }}
            </p>
          </div>
          <footer>
            <time
              >更新于
              {{ (item.updated_at ?? item.created_at).slice(5, 16).replace("T", " ") }}</time
            >
            <span>{{ item.user_id === auth.state.context?.userId ? "我创建的" : "共享报表" }}</span>
          </footer>
        </RouterLink>
        <ElDropdown
          v-if="item.definition_version && item.user_id === auth.state.context?.userId"
          trigger="click"
          class="report-card-menu"
          @command="editing = item.report_id"
          ><ElButton text :aria-label="`${item.title}的更多操作`"><Ellipsis :size="18" /></ElButton
          ><template #dropdown
            ><ElDropdownMenu
              ><ElDropdownItem command="rename">修改名称与说明</ElDropdownItem></ElDropdownMenu
            ></template
          ></ElDropdown
        >
      </article>
    </div>
    <p v-if="items.length && !state.nextCursor" class="muted report-list-end">
      已显示 {{ items.length }} 份报表
    </p>
    <ReportMetadataEditor
      :report-id="editing"
      @close="editing = ''"
      @saved="
        editing = '';
        reports.list();
      "
    />
    <div v-if="state.nextCursor" class="report-load">
      <ElButton :loading="state.listing" @click="reports.list(true)">加载更多报表</ElButton>
    </div>
  </section>
</template>
