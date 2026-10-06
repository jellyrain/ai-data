<script setup lang="ts">
import type { KnowledgeContent, ReportDefinitionVersion } from "@ai-data/contracts";
import MarkdownContent from "../../../shared/content/markdown-content.vue";
withDefaults(
  defineProps<{
    content: KnowledgeContent;
    template?: ReportDefinitionVersion | null;
    showHeading?: boolean;
  }>(),
  { showHeading: true, template: null },
);
</script>
<template>
  <template v-if="content.type === 'business_rule'"
    ><h3 v-if="showHeading">{{ content.title }}</h3>
    <MarkdownContent :text="content.body"
  /></template>
  <template v-else-if="content.type === 'metric'"
    ><h3 v-if="showHeading">{{ content.definition.name }}</h3>
    <MarkdownContent :text="content.definition.description" />
    <dl class="knowledge-details">
      <dt>统计粒度</dt>
      <dd>{{ content.definition.grain }}</dd>
      <dt>时间依据</dt>
      <dd>{{ content.definition.date_basis.field }}</dd>
      <dt>去重键</dt>
      <dd>{{ content.definition.deduplication_keys.join("、") || "无" }}</dd>
      <dt>维度</dt>
      <dd>{{ content.definition.dimensions.join("、") || "总计" }}</dd>
      <dt>计算方式</dt>
      <dd>
        {{
          content.definition.value.type === "column"
            ? content.definition.value.column
            : content.definition.value.numerator + " / " + content.definition.value.denominator
        }}
      </dd>
    </dl>
    <details>
      <summary>查看完整指标定义</summary>
      <pre>{{ JSON.stringify(content.definition, null, 2) }}</pre>
    </details></template
  >
  <template v-else
    ><h3 v-if="showHeading">{{ template?.definition.title ?? "组织报表模板" }}</h3>
    <p class="management-help">
      报表 {{ content.report_id }} · 定义 v{{ content.definition_version }}
    </p>
    <p class="management-help">内容摘要：{{ content.definition_hash }}</p>
    <template v-if="template"
      ><p>参数：{{ template.definition.parameters.map((item) => item.name).join("、") || "无" }}</p>
      <p>
        查询 {{ template.definition.queries.length }} 项 · 展示分区
        {{ template.definition.presentation.length }} 项
      </p>
      <section
        v-for="section in template.definition.presentation"
        :key="section.section_id"
        class="management-section"
      >
        <h4>{{ section.title }}</h4>
        <article v-for="block in section.blocks" :key="block.block_id" class="knowledge-source">
          <strong>{{ block.title }}</strong>
          <p class="management-help">
            {{ { text: "说明", table: "表格", chart: "图表" }[block.type] }} · 查询
            {{ block.query_ids.join("、") }}
          </p>
          <MarkdownContent v-if="block.type === 'text'" :text="block.content ?? ''" />
          <p v-if="block.columns">列：{{ block.columns.join("、") }}</p>
          <p v-if="block.chart">
            {{ { bar: "柱形图", line: "折线图", pie: "饼图" }[block.chart.type] }} ·
            {{ block.chart.x }} / {{ block.chart.y }}
          </p>
        </article>
      </section>
      <details>
        <summary>固定版本的完整参数与查询定义</summary>
        <pre>{{ JSON.stringify(template.definition, null, 2) }}</pre>
      </details></template
    ></template
  >
</template>
