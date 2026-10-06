(() => {
  const data = globalThis.AIBIDemoData;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const number = (value) => Number(value).toLocaleString("zh-CN");
  const icons = {
    chart: '<path d="M4 19V9m5 10V5m5 14v-7m5 7V3"/>',
    chat: '<path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 1 1 18 0Z"/><path d="M7 10h8M7 14h5"/>',
    report: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/>',
    settings:
      '<path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/><circle cx="12" cy="12" r="3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    up: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    database:
      '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
    share:
      '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 10 6-4M9 14l6 4"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    save: '<path d="M5 3h12l4 4v14H3V3Z"/><path d="M7 3v6h10V3M7 21v-7h10v7"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    retry: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8Zm-9 9 9 5 9-5m-18 5 9 5 9-5"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',
  };
  const icon = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.chart}</svg>`;
  const btn = (label, action, kind = "", symbol = "", attributes = "") =>
    `<button type="button" class="btn ${kind}" data-action="${action}" ${attributes}>${symbol ? icon(symbol) : ""}${label}</button>`;
  const badge = (label, kind = "") =>
    `<span class="badge ${kind}">${label}</span>`;
  const notice = (text, kind = "info") =>
    `<div class="notice ${kind}">${icon("info")}<div>${text}</div></div>`;
  const months = { august: "2026 年 8 月", july: "2026 年 7 月" };
  const state = {
    page: ["analysis", "report", "settings"].includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : "analysis",
    boundAgent: clone(data.agent),
    menu: false,
    chat: "completed",
    question: "8 月门诊量相比上月有什么变化？按科室看看。",
    clarification: "按挂号时间",
    runToken: 0,
    tablePage: 1,
    pageSize: 3,
    chartMode: "chart",
    adminTab: "agents",
    adminScenario: "normal",
    selectedResource: 0,
    agents: [
      { definition: clone(data.agent), enabled: true, history: [1, 2] },
      {
        definition: {
          ...clone(data.agent),
          agent_id: "demo-metric",
          name: "指标口径助手",
          version: 1,
          description: "查阅已发布指标，解释统计口径与适用范围。",
        },
        enabled: false,
        history: [1],
      },
    ],
    models: [{ ...clone(data.model), history: [1, 2, 3] }],
    definition: clone(data.definition),
    definitionVersion: 3,
    shares: ["陈宁"],
    draft: null,
    editorMode: "form",
    parameters: { month: "august", department: "all" },
    executionIndex: 1,
    executing: false,
    reportError: "",
    reportScenario: "normal",
    executions: [
      {
        id: "demo-execution-001",
        definitionVersion: 2,
        snapshotVersion: 1,
        month: "july",
        department: "all",
        time: "2026-08-01 09:20:00",
      },
      {
        id: "demo-execution-002",
        definitionVersion: 3,
        snapshotVersion: 2,
        month: "august",
        department: "all",
        time: "2026-09-01 09:30:00",
      },
    ],
  };
  const app = document.querySelector("#app");
  const dialog = document.querySelector("#dialog");
  let toastTimer;
  let lastFocus;
  let dialogToken = 0;
  const currentExecution = () => state.executions[state.executionIndex];
  const resultRows = (execution = currentExecution()) =>
    data.departments.filter(
      (row) =>
        execution.department === "all" ||
        row.department === execution.department,
    );
  const total = (rows, month) => rows.reduce((sum, row) => sum + row[month], 0);

  function toast(message) {
    const element = document.querySelector("#toast");
    clearTimeout(toastTimer);
    element.textContent = message;
    element.classList.add("visible");
    toastTimer = setTimeout(() => element.classList.remove("visible"), 3600);
  }

  function navigate(page) {
    state.menu = false;
    if (location.hash === `#${page}`) {
      state.page = page;
      render();
    } else location.hash = page;
  }

  function render() {
    const titles = {
      analysis: "分析工作台",
      report: "报表详情",
      settings: "模型与 Agent",
    };
    document.title = `AI BI · ${titles[state.page]}`;
    app.innerHTML = `<div class="shell ${state.menu ? "menu-open" : ""}">
      <aside class="sidebar" aria-label="主导航">
        <div class="brand"><span class="brand-mark">${icon("chart")}</span>AI BI</div><p class="workspace-label">让每一次分析都有依据</p>
        ${btn("新建分析", "new-chat", "full-width", "plus")}
        <nav class="nav" aria-label="工作空间">${[
          ["analysis", "chat", "分析工作台"],
          ["report", "report", "报表中心"],
        ]
          .map(
            ([page, symbol, label]) =>
              `<button data-page="${page}" class="${state.page === page ? "active" : ""}" ${state.page === page ? 'aria-current="page"' : ""}>${icon(symbol)}${label}</button>`,
          )
          .join("")}</nav>
        <div class="sidebar-conversations"><p class="section-label">最近的分析</p><button class="conversation-link ${state.chat !== "empty" ? "selected" : ""}" data-action="existing-chat">门诊量月度分析</button><button class="conversation-link" data-action="example-chat">查看首次提问示例</button></div>
        <div class="sidebar-bottom"><p class="section-label">管理</p><nav class="nav" aria-label="管理"><button data-page="settings" class="${state.page === "settings" ? "active" : ""}" ${state.page === "settings" ? 'aria-current="page"' : ""}>${icon("settings")}模型与 Agent</button></nav>
        <div class="identity"><div class="avatar">林</div><div><strong>林悦</strong><span>示例组织 · 运营管理</span></div></div></div>
      </aside>
      <div class="main-shell"><header class="topbar"><div class="breadcrumbs"><button class="icon-btn mobile-menu" data-action="menu" aria-label="展开主导航" aria-expanded="${state.menu}">${icon("menu")}</button><span>${state.page === "settings" ? "管理设置" : "工作空间"}</span><span>/</span><strong>${titles[state.page]}</strong></div><div class="topbar-actions"><span class="prototype-tag">交互原型 · 模拟数据</span>${btn("演示场景", "scenarios", "compact ghost", "eye")}</div></header>
      <main id="main-content" class="page" tabindex="-1">${state.page === "analysis" ? analysisPage() : state.page === "report" ? reportPage() : settingsPage()}</main></div></div>`;
  }

  function chart(rows, month = "august", comparison = true) {
    const width = 620,
      step = 530 / rows.length;
    return `<div class="chart"><div class="chart-key">${comparison && month === "august" ? '<span><i class="previous"></i>7 月</span>' : ""}<span><i></i>${month === "august" ? "8" : "7"} 月</span></div><svg viewBox="0 0 ${width} 245" role="img" aria-label="各科室门诊量柱状图，详细数据见下方表格"><title>各科室门诊量</title>${[0, 1000, 2000, 3000, 4000].map((value) => `<line class="grid" x1="49" y1="${202 - value * 0.044}" x2="609" y2="${202 - value * 0.044}"/><text x="39" y="${206 - value * 0.044}" text-anchor="end">${value === 0 ? "0" : value / 1000 + "k"}</text>`).join("")}${rows
      .map((row, index) => {
        const x = 63 + step * index + step / 2;
        return `${comparison && month === "august" ? `<rect class="bar-previous" x="${x - 27}" y="${202 - row.july * 0.044}" width="21" height="${row.july * 0.044}" rx="3"/>` : ""}<rect class="bar" x="${x - (comparison && month === "august" ? 0 : 13)}" y="${202 - row[month] * 0.044}" width="${comparison && month === "august" ? 21 : 27}" height="${row[month] * 0.044}" rx="3"><title>${escape(row.department)}：${number(row[month])} 人次</title></rect><text x="${x - 3}" y="226" text-anchor="middle">${escape(row.department)}</text>`;
      })
      .join("")}</svg></div>`;
  }

  function resultTable(rows, month = "august", comparison = true) {
    const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.tablePage = Math.min(state.tablePage, pages);
    const offset = (state.tablePage - 1) * state.pageSize;
    return `<div class="table-wrap" tabindex="0" aria-label="科室门诊量结果表"><table><thead><tr><th>科室</th>${comparison && month === "august" ? '<th class="number">7 月人次</th>' : ""}<th class="number">${month === "august" ? "8" : "7"} 月人次</th><th class="number">${comparison && month === "august" ? "环比变化" : "占比"}</th></tr></thead><tbody>${rows
      .slice(offset, offset + state.pageSize)
      .map(
        (row) =>
          `<tr><td>${escape(row.department)}</td>${comparison && month === "august" ? `<td class="number muted">${number(row.july)}</td>` : ""}<td class="number">${number(row[month])}</td><td class="number ${comparison && month === "august" ? "positive" : ""}">${comparison && month === "august" ? `+${((row.august / row.july - 1) * 100).toFixed(1)}%` : `${((row[month] / total(rows, month)) * 100).toFixed(1)}%`}</td></tr>`,
      )
      .join(
        "",
      )}</tbody></table></div><div class="table-footer"><span>完整结果 · 共 ${rows.length} 行</span><div class="pagination"><label class="sr-only" for="page-size">每页条数</label><select id="page-size" data-change="page-size">${[3, 6, 10].map((size) => `<option value="${size}" ${size === state.pageSize ? "selected" : ""}>${size} 条 / 页</option>`).join("")}</select><button class="icon-btn" data-action="previous-page" aria-label="上一页" ${state.tablePage === 1 ? "disabled" : ""}>‹</button><span>${state.tablePage} / ${pages}</span><button class="icon-btn" data-action="next-page" aria-label="下一页" ${state.tablePage === pages ? "disabled" : ""}>›</button></div></div>`;
  }

  function resultPanel(rows = data.departments, month = "august") {
    return `<section class="result-panel" aria-label="科室对比结果"><div class="panel-heading"><div><h3>各科室门诊量</h3><p>${months[month]} · 单位：人次</p></div><div class="segment" aria-label="结果显示方式"><button data-chart="chart" aria-pressed="${state.chartMode === "chart"}" class="${state.chartMode === "chart" ? "active" : ""}">图表 + 明细</button><button data-chart="table" aria-pressed="${state.chartMode === "table"}" class="${state.chartMode === "table" ? "active" : ""}">明细</button></div></div>${state.chartMode === "chart" ? chart(rows, month) : ""}${resultTable(rows, month)}</section>`;
  }

  function inspector() {
    if (state.chat !== "completed")
      return `<aside class="inspector" aria-label="分析依据"><h3>${icon("layers")}分析依据</h3><p class="muted small">${state.chat === "running" ? "正在读取演示数据，完成后展示查询范围与证据。" : "完成分析后，在这里查看查询条件、来源、统计口径和证据。"}</p></aside>`;
    return `<aside class="inspector" aria-label="分析依据"><h3>${icon("layers")}分析依据</h3><section class="inspector-section"><h4>本次查询条件</h4><dl class="key-value"><dt>分析时间</dt><dd>2026.08.01 — 08.31</dd></dl><dl class="key-value"><dt>对比时间</dt><dd>2026.07.01 — 07.31</dd></dl><dl class="key-value"><dt>数据范围</dt><dd>全部获授权科室</dd></dl><dl class="key-value"><dt>时间口径</dt><dd>${escape(state.clarification)}</dd></dl></section><section class="inspector-section"><h4>来源与口径</h4><dl class="key-value"><dt>数据来源</dt><dd>${icon("database")} 示例门诊数据集</dd></dl><dl class="key-value"><dt>指标定义</dt><dd>门诊人次 · v2</dd></dl><dl class="key-value"><dt>数据更新时间</dt><dd>2026.09.01 08:00</dd></dl>${btn("查看查询证据", "evidence", "compact", "report")}</section><section class="inspector-section"><h4>分析过程</h4><ol class="timeline"><li>确认统计口径<small>门诊人次 · ${escape(state.clarification)}</small></li><li>读取科室汇总<small>授权范围内的 6 个科室分组</small></li><li>${state.chat === "running" ? "正在整理分析" : "核对结果并形成说明"}<small>按科室核对总量</small></li></ol></section><details><summary>会话配置</summary><p class="small m-top">${escape(state.boundAgent.name)} v${state.boundAgent.version}<br>${escape(state.boundAgent.model_id)} v${state.boundAgent.model_version}<br>本会话使用创建时绑定的版本。</p></details></aside>`;
  }

  function analysisPage() {
    const active = ["running", "clarification"].includes(state.chat);
    const statuses = {
      completed: "分析已完成",
      running: "正在分析",
      clarification: "等待你的确认",
      failed: "本次分析失败",
      cancelled: "已取消",
      empty_result: "查询已完成",
      empty: "新的分析",
    };
    return `<div class="page-heading"><div><h1>${state.chat === "empty" ? "分析工作台" : "门诊量月度分析"}</h1><div class="heading-meta"><span class="muted small">${state.chat === "empty" ? "创建会话时选择 Agent" : `${escape(state.boundAgent.name)} v${state.boundAgent.version}`}</span>${badge(statuses[state.chat], state.chat === "failed" ? "danger" : state.chat === "completed" ? "success" : "gold")}</div></div><div class="actions">${state.chat === "completed" ? btn("保存为报表", "save-report", "", "save") : btn("页面地图", "page-map", "", "layers")}</div></div>
      <div class="analysis-grid"><section class="conversation" aria-label="分析对话">${state.chat === "empty" ? `<div class="empty-state"><div class="empty-icon">${icon("chart")}</div><h2>今天，从哪个问题开始？</h2><p>描述你关心的指标和时间范围，助手会确认口径，再结合数据给出分析。</p><div class="suggestions">${btn("8 月门诊量有什么变化？", "sample-question", "", "arrow")}</div></div>` : `<div class="user-message"><div class="user-bubble">${escape(state.question)}</div></div><div class="assistant-meta"><div class="assistant-mark">${icon("chart")}</div><strong>${escape(state.boundAgent.name)}</strong><span>本次分析</span></div><div class="answer">${chatAnswer()}</div>`}
      <form class="composer" id="chat-form"><label class="sr-only" for="question">${active ? "当前分析进行中" : "输入分析问题"}</label><textarea id="question" name="question" rows="2" placeholder="${active ? "当前分析完成后可以继续追问" : "继续提问，例如：内科的增长占整体增长多少？"}" ${active ? "disabled" : ""}></textarea><div class="composer-bottom">${
        state.chat === "empty"
          ? `<label class="small">Agent <select name="agent" aria-label="选择 Agent">${
              state.agents
                .filter((entry) => entry.enabled)
                .map(
                  (entry) =>
                    `<option value="${escape(entry.definition.agent_id)}">${escape(entry.definition.name)} · v${entry.definition.version}</option>`,
                )
                .join("") || `<option value="">暂无可用 Agent</option>`
            }</select></label>`
          : `<span class="muted small">${icon("layers")} ${escape(state.boundAgent.name)} · v${state.boundAgent.version}</span>`
      }${state.chat === "running" ? btn("停止分析", "cancel-run", "", "stop") : `<button class="btn primary" type="submit" ${active ? "disabled" : ""}>${icon("up")}发送</button>`}</div></form><p class="composer-note">原型演示使用固定样例结果，数据与分析内容均为虚构。</p></section>${inspector()}</div>`;
  }

  function chatAnswer() {
    if (state.chat === "completed")
      return `<h2>8 月门诊量增长 8.0%，内科贡献最大</h2><p>本月共 <strong>12,480 人次</strong>，比 7 月增加 <strong>920 人次</strong>。内科增加 420 人次，占整体增量的 45.7%；儿科增加 200 人次，增长同样明显。</p>${resultPanel()}<div class="answer-actions">${btn("查看证据", "evidence", "ghost compact", "database")}${btn("保存为报表", "save-report", "ghost compact", "save")}${btn("导出", "export", "ghost compact", "download")}</div><div class="notice">${icon("info")}<div>科室增量反映变化分布。具体增长原因，需要结合接诊安排等业务信息进一步核实。</div></div><div class="suggestions"><span class="muted small">继续探索</span><button data-followup="内科的增长占整体增长多少？">内科的增长贡献</button><button data-action="evidence">这次用了什么统计口径？</button></div>`;
    if (state.chat === "clarification")
      return `<div class="state-box"><span class="badge gold">需要确认</span><h3 class="m-top">${escape(data.clarification.question)}</h3><p>两个口径分别对应不同指标。确认后，本次查询和结果会使用同一口径。</p><div class="clarification-options">${data.clarification.options.map((option) => btn(escape(option.label), "clarify", "", "", `data-option="${option.id}"`)).join("")}</div><form id="clarification-form" class="custom-answer"><label class="sr-only" for="custom-answer">自定义统计口径</label><input id="custom-answer" name="answer" placeholder="或补充你需要的口径" required maxlength="200"/><button class="btn" type="submit">确认</button></form></div>`;
    if (state.chat === "running")
      return `<div class="state-box"><h3><span class="pulse"></span> 正在分析科室变化</h3><p>已确认${escape(state.clarification)}，正在核对科室汇总与结果完整性。</p><div class="actions">${btn("取消本次分析", "cancel-run", "", "stop")}</div></div>`;
    if (state.chat === "failed")
      return `<div class="state-box">${badge("分析未完成", "danger")}<h3 class="m-top">暂时无法取得数据</h3><p>本次运行未生成结果。你可以保留问题，重新发起一次分析。</p><div class="actions">${btn("重新发起分析", "restart-run", "primary", "retry")}</div></div>`;
    if (state.chat === "cancelled")
      return `<div class="state-box"><h3>本次分析已取消</h3><p>你可以调整问题后再次发送。已有会话内容仍然保留。</p><div class="actions">${btn("编辑原问题", "edit-question", "", "edit")}</div></div>`;
    return `<div class="state-box"><h3>当前条件下没有查询结果</h3><p>查询已经完成，返回 0 行。请确认时间范围与科室条件后，再发起新的分析。</p><div class="actions">${btn("调整问题", "edit-question", "", "edit")}</div></div>`;
  }

  function reportPage() {
    const execution = currentExecution(),
      rows = resultRows(),
      count = total(rows, execution.month);
    const dirty =
      state.parameters.month !== execution.month ||
      state.parameters.department !== execution.department;
    return `<div class="page-heading"><div><h1>${escape(state.definition.title)}</h1><div class="heading-meta"><span class="muted small">林悦创建</span>${badge(`定义 v${state.definitionVersion}`)}${badge(state.shares.length ? `已分享给 ${state.shares.length} 人` : "仅自己可见", "gold")}</div></div><div class="actions">${btn("编辑", "edit-report", "", "edit")}${btn("分享", "share", "", "share")}${btn("导出", "export", "primary", "download")}</div></div>
      <form id="report-form" class="parameters"><div class="field"><label for="report-month">统计月份</label><select id="report-month" name="month" data-change="report-month">${Object.entries(
        months,
      )
        .map(
          ([value, label]) =>
            `<option value="${value}" ${state.parameters.month === value ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select></div><div class="field"><label for="report-department">科室范围</label><select id="report-department" name="department" data-change="report-department"><option value="all">全部获授权科室</option>${data.departments.map((row) => `<option ${state.parameters.department === row.department ? "selected" : ""}>${escape(row.department)}</option>`).join("")}</select></div><div class="parameter-actions"><span class="muted small">按挂号时间统计</span><button type="submit" class="btn primary" ${state.executing ? "disabled" : ""}>${state.executing ? '<span class="pulse"></span>正在运行' : icon("arrow") + "运行报表"}</button></div></form>
      ${state.reportError ? notice(escape(state.reportError), "error") : dirty ? notice("参数已修改，下面仍显示上次执行结果。点击“运行报表”生成新结果。", "warning") : ""}
      <div class="results-meta"><span>结果：${months[execution.month]} · ${execution.department === "all" ? "全部获授权科室" : escape(execution.department)} · 使用定义 v${execution.definitionVersion}</span><label>查看结果 <select data-change="execution" aria-label="查看历史执行结果">${state.executions.map((item, index) => `<option value="${index}" ${index === state.executionIndex ? "selected" : ""}>快照 v${item.snapshotVersion} · ${months[item.month]} · ${item.department === "all" ? "全部科室" : escape(item.department)}</option>`).join("")}</select></label></div>
      <div class="report-summary"><div class="summary-item"><span>门诊人次</span><strong>${number(count)}<small>人次</small></strong></div><div class="summary-item"><span>${execution.month === "august" ? "较 7 月" : "统计科室"}</span><strong class="${execution.month === "august" ? "positive" : ""}">${execution.month === "august" ? `+${((count / total(rows, "july") - 1) * 100).toFixed(1)}%` : rows.length}<small>${execution.month === "august" ? "" : "个"}</small></strong></div><div class="summary-item"><span>结果完整性</span><strong style="font-size:18px">完整结果</strong><p class="small muted">${rows.length} 个科室分组</p></div></div>
      <div class="report-layout"><div>${resultPanel(rows, execution.month)}<p class="muted small m-top">数据更新时间：${execution.month === "august" ? "2026-09-01" : "2026-08-01"} 08:00 · 示例门诊数据集</p></div><aside class="report-narrative"><h3>分析说明</h3>${execution.id === "demo-execution-002" ? "<p><strong>内科是本月增量的主要来源。</strong>8 月增加 420 人次，占整体增量的 45.7%。儿科增加 200 人次，占 21.7%。</p><p>上述分布帮助定位进一步调查的科室，业务原因仍需结合接诊与排班信息核实。</p>" : `<p>本次结果为${months[execution.month]}的科室汇总，共 ${number(count)} 人次。</p><p>本次执行尚未生成 AI 分析说明，可以针对当前结果发起生成。</p>${btn("生成分析说明", "narrate", "compact", "chat")}`}<div class="notice"><div><strong>本结果的记录</strong><p class="small m-top">定义 v${execution.definitionVersion} · 快照 v${execution.snapshotVersion}<br>生成时间：${execution.time}</p><span class="mono">${execution.id}</span></div></div><div class="m-top">${btn("查看来源与证据", "evidence", "compact", "database")}</div></aside></div>`;
  }

  function settingsPage() {
    const isAgent = state.adminTab === "agents",
      items = isAgent ? state.agents : state.models;
    const selected = items[Math.min(state.selectedResource, items.length - 1)];
    const item = isAgent ? selected.definition : selected;
    return `<div class="page-heading"><div><h1>模型与 Agent</h1><p>管理分析能力、固定版本与运行配置。</p></div><div class="actions">${btn(isAgent ? "新建 Agent" : "新建模型", "new-resource", "primary", "plus")}</div></div><div class="tabs" aria-label="配置分类"><button data-admin-tab="agents" class="${isAgent ? "active" : ""}">Agent <span class="count">${state.agents.length}</span></button><button data-admin-tab="models" class="${!isAgent ? "active" : ""}">模型 <span class="count">${state.models.length}</span></button></div>${notice("发布配置会创建新版本。已有会话继续使用创建时绑定的 Agent 与模型版本。")}
      ${
        state.adminScenario === "empty"
          ? `<div class="empty-state"><div class="empty-icon">${icon("settings")}</div><h2>添加第一个${isAgent ? " Agent" : "模型"}</h2><p>${isAgent ? "选择模型版本、工具和 Skill，配置业务分析能力。" : "设置模型连接和认证方式，供 Agent 绑定使用。"}</p>${btn(isAgent ? "新建 Agent" : "新建模型", "new-resource", "primary", "plus")}</div>`
          : `<div class="admin-layout m-top"><div><div class="resource-list">${items
              .map((entry, index) => {
                const resource = isAgent ? entry.definition : entry;
                return `<button class="resource-row ${index === state.selectedResource ? "selected" : ""}" data-resource="${index}" aria-pressed="${index === state.selectedResource}"><div class="resource-row-heading"><strong>${escape(resource.name)}</strong>${badge(entry.enabled ? "已启用" : "已停用", entry.enabled ? "success" : "")}</div><p>${escape(isAgent ? resource.description : "Responses 协议 · 凭据加密管理")}</p><footer><span>${isAgent ? `${resource.skill_names.length} 个 Skill · ${resource.tool_names.length} 个工具` : escape(resource.model)}</span><span>最新 v${resource.version}</span></footer></button>`;
              })
              .join(
                "",
              )}</div><p class="muted small m-top">${isAgent ? "选择 Agent 查看配置与历史版本。" : "模型凭据仅显示配置状态。"}</p></div><section class="resource-detail"><div class="detail-heading"><div><h2>${escape(item.name)}</h2><p>${escape(isAgent ? item.agent_id : item.model_id)} · v${item.version}</p></div>${btn(selected.enabled ? "停用" : "启用", "toggle-resource", selected.enabled ? "compact" : "primary compact")}</div><div class="detail-body"><dl class="definition-list">${isAgent ? `<dt>模型版本</dt><dd>业务分析模型 · v${item.model_version}</dd><dt>分析说明</dt><dd>${escape(item.description)}</dd><dt>工具</dt><dd class="tags">${item.tool_names.map((name) => badge(escape(name))).join("")}</dd><dt>Skills</dt><dd class="tags">${item.skill_names.map((name) => badge(escape(name))).join("")}</dd><dt>执行预算</dt><dd>${item.limits.timeout_ms / 1000} 秒 · 最多 ${item.limits.max_tool_calls} 次工具调用</dd>` : `<dt>协议</dt><dd>Responses</dd><dt>服务地址</dt><dd class="mono">${escape(item.base_url)}</dd><dt>模型名称</dt><dd>${escape(item.model)}</dd><dt>上下文容量</dt><dd>${number(item.context_window)} tokens</dd><dt>API Key</dt><dd>${badge(item.has_api_key ? "已配置" : "未配置", item.has_api_key ? "success" : "")}</dd><dt>自定义请求头</dt><dd>${item.header_names.length ? escape(item.header_names.join("、")) : "0 项"}</dd>`}</dl><div class="detail-section"><div class="actions" style="justify-content:space-between"><h3>版本记录</h3>${btn("发布新版本", "publish-resource", "compact", "plus")}</div>${[
              ...selected.history,
            ]
              .reverse()
              .map(
                (version) =>
                  `<div class="version-row"><div><strong>v${version}</strong> ${version === item.version ? badge("最新版本", "gold") : ""}<small>${version === item.version ? "当前发布配置" : "已发布的历史配置"}</small></div>${btn("查看", "version-detail", "ghost compact", "", `data-version="${version}"`)}</div>`,
              )
              .join("")}</div></div></section></div>`
      }`;
  }

  // 弹窗和事件在下方统一装配；所有输入先转义后进入展示模板。
  function openDialog(title, body, footer = "", wide = false) {
    dialogToken += 1;
    if (!dialog.open) lastFocus = document.activeElement;
    dialog.className = wide ? "wide" : "";
    dialog.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-btn" data-action="close-dialog" aria-label="关闭弹窗">${icon("close")}</button></div><div class="dialog-body">${body}</div>${footer ? `<div class="dialog-footer">${footer}</div>` : ""}`;
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog() {
    dialog.close();
  }

  function runChat() {
    state.chat = "running";
    const token = ++state.runToken;
    render();
    setTimeout(() => {
      if (token !== state.runToken || state.chat !== "running") return;
      state.chat = "completed";
      state.tablePage = 1;
      render();
      toast("分析已完成，查看结果与证据");
    }, 1600);
  }

  function scenarios() {
    const options =
      state.page === "analysis"
        ? [
            ["empty", "新会话"],
            ["running", "运行中"],
            ["clarification", "等待澄清"],
            ["completed", "分析完成"],
            ["failed", "分析失败"],
            ["empty_result", "空结果"],
            ["cancelled", "已取消"],
          ]
        : state.page === "report"
          ? [
              ["normal", "正常执行"],
              ["failed", "执行失败"],
              ["conflict", "保存版本冲突"],
              ["export_failed", "导出失败"],
            ]
          : [
              ["normal", "正常配置"],
              ["empty", "首次配置空态"],
              ["failed", "发布失败"],
            ];
    openDialog(
      "演示场景",
      `<p class="modal-note">切换当前页面的模拟状态，检查关键操作与提示。</p><div class="scenario-list">${options.map(([value, label]) => btn(label, "set-scenario", "", "", `data-scenario="${value}"`)).join("")}</div>`,
      btn("查看页面地图", "page-map", "ghost", "layers") +
        btn("关闭", "close-dialog"),
    );
  }

  function evidence() {
    const execution =
      state.page === "report" ? currentExecution() : state.executions[1];
    openDialog(
      "来源与查询证据",
      `<p class="modal-note">展示当前结果的范围与依据，以下均为演示数据。</p><dl class="definition-list"><dt>指标</dt><dd>门诊人次 · v2</dd><dt>统计时间</dt><dd>${months[execution.month]}</dd><dt>统计口径</dt><dd>${state.page === "analysis" ? escape(state.clarification) : "按挂号时间"}，每条有效记录计 1 人次</dd><dt>数据来源</dt><dd>示例门诊数据集</dd><dt>授权范围</dt><dd>${execution.department === "all" ? "全部获授权科室" : escape(execution.department)}</dd><dt>结果完整性</dt><dd>完整结果 · ${resultRows(execution).length} 个科室分组</dd><dt>数据更新时间</dt><dd>${execution.month === "august" ? "2026-09-01" : "2026-08-01"} 08:00:00</dd><dt>生成时间</dt><dd>${execution.time}</dd><dt>执行标识</dt><dd class="mono">${execution.id}</dd></dl>`,
      btn("完成", "close-dialog", "primary"),
    );
  }

  function pageMap() {
    openDialog(
      "页面地图",
      `<p class="modal-note">本轮可交互页面：分析工作台、报表详情、模型与 Agent 管理。</p><div class="map-list"><section><h3>业务工作空间</h3><p>分析工作台 → 会话与结果<br>报表中心 → 详情 → 表单 / 画布 / 对话编辑<br>知识查阅与个人偏好</p></section><section><h3>管理设置</h3><p>用户与权限<br>DAS、数据目录与关系<br>模型、Agent 与 Skill<br>知识审核与后台任务</p></section></div>`,
      btn("查看分析工作台", "go-analysis", "", "chat") +
        btn("查看报表详情", "go-report", "", "report") +
        btn("查看模型与 Agent", "go-settings", "primary", "settings"),
      true,
    );
  }

  function editReport(mode = "form") {
    state.editorMode = mode;
    if (!state.draft)
      state.draft = {
        title: state.definition.title,
        expectedVersion: state.definitionVersion,
      };
    const content =
      mode === "form"
        ? `<div class="field"><label for="edit-title">报表名称</label><input id="edit-title" value="${escape(state.draft.title)}" maxlength="512" required/><small>定义基准 v${state.draft.expectedVersion}，保存后生成新版本。</small></div><div class="detail-section"><h3>运行参数</h3><div class="table-wrap"><table><thead><tr><th>参数</th><th>类型</th><th>必填</th></tr></thead><tbody>${state.definition.parameters.map((parameter) => `<tr><td>${escape(parameter.label)}</td><td>日期</td><td>是</td></tr>`).join("")}</tbody></table></div></div>`
        : mode === "canvas"
          ? `<div class="editor-canvas"><div class="canvas-node"><h3>门诊人次 · v2</h3><p>按科室分组<br>绑定开始日期、结束日期</p></div>${icon("arrow")}<div class="canvas-node"><h3>${escape(state.draft.title)}</h3><p>科室对比图<br>结果明细表</p></div></div><p class="modal-note m-top">画布展示查询与结果的连接关系，三个入口使用同一份定义草稿。本轮演示切换路径与内容保留。</p>`
          : `<div class="field"><label for="revision-request">描述你想修改的内容</label><textarea id="revision-request" rows="3" placeholder="例如：把标题改成“门诊量与科室结构分析”"></textarea></div><div class="actions m-top">${btn("预览示例修改", "preview-revision", "", "chat")}</div><p class="modal-note m-top">模拟修改会将草稿标题设为“门诊量与科室结构分析”，供你确认后保存。</p>`;
    openDialog(
      "编辑报表定义",
      `<div class="tabs">${[
        ["form", "表单编辑"],
        ["canvas", "画布编辑"],
        ["conversation", "对话编辑"],
      ]
        .map(
          ([value, label]) =>
            `<button data-editor="${value}" class="${mode === value ? "active" : ""}">${label}</button>`,
        )
        .join(
          "",
        )}</div>${content}<div id="edit-error" class="field-error" role="alert"></div><div id="conflict-actions"></div>`,
      `<small id="draft-summary">当前草稿：${escape(state.draft.title)}</small>${btn("关闭", "close-dialog")}${btn("保存定义", "save-definition", "primary", "save")}`,
      true,
    );
  }

  function captureDraft() {
    const input = document.querySelector("#edit-title");
    if (input && state.draft) {
      state.draft.title = input.value.trim();
      const summary = document.querySelector("#draft-summary");
      if (summary) summary.textContent = `当前草稿：${state.draft.title}`;
    }
  }

  function saveDefinition() {
    captureDraft();
    const error = document.querySelector("#edit-error");
    if (!state.draft.title) {
      error.textContent = "请填写报表名称。";
      return;
    }
    if (
      state.reportScenario === "conflict" ||
      state.draft.expectedVersion !== state.definitionVersion
    ) {
      if (state.reportScenario === "conflict") {
        state.definitionVersion += 1;
        state.reportScenario = "normal";
      }
      error.textContent = `当前定义已更新到 v${state.definitionVersion}。你的草稿已保留，请核对后基于最新版本保存。`;
      document.querySelector("#conflict-actions").innerHTML =
        `<div class="m-top">${btn("保留草稿并采用最新基准", "resolve-conflict")}</div>`;
      return;
    }
    state.definition.title = state.draft.title;
    state.definitionVersion += 1;
    state.draft = null;
    closeDialog();
    render();
    toast(`定义 v${state.definitionVersion} 已保存，运行报表后生成新结果`);
  }

  function shareReport() {
    state.shareBase = state.definitionVersion;
    openDialog(
      "分享报表",
      `<p class="modal-note">为示例组织成员授予报表访问权。查看历史结果还需要具备对应数据范围权限。</p><div>${["陈宁", "周然", "顾远"].map((name) => `<label class="check-option"><input type="checkbox" name="share-user" value="${name}" ${state.shares.includes(name) ? "checked" : ""}/><span>${name}<small>示例组织成员</small></span></label>`).join("")}</div>${notice("成员为虚构选项。正式接入时使用经批准的组织成员查询接口。")}`,
      btn("取消", "close-dialog") + btn("保存分享", "save-sharing", "primary"),
    );
  }

  function exportDialog() {
    const execution = clone(
      state.page === "report" ? currentExecution() : state.executions[1],
    );
    state.exportExecution = execution;
    openDialog(
      "导出分析结果",
      `<p class="modal-note">${months[execution.month]} · 快照 v${execution.snapshotVersion} · ${resultRows(execution).length} 行完整分组结果</p><form id="export-form"><div class="format-list">${[
        ["Excel", "完整结果表"],
        ["Word", "可编辑分析文档"],
        ["PDF", "固定版式报告"],
      ]
        .map(
          ([format, desc], index) =>
            `<label><input type="radio" name="format" value="${format}" ${index === 0 ? "checked" : ""}/><strong>${format}</strong><small>${desc}</small></label>`,
        )
        .join(
          "",
        )}</div></form><div id="export-progress">${notice("本轮演示生成状态与内容范围；实际文件生成在前端第 7 步接入。")}</div>`,
      btn("关闭", "close-dialog") +
        btn("演示生成流程", "generate-export", "primary", "download"),
    );
  }

  function generateExport(button) {
    const token = dialogToken,
      format = new FormData(document.querySelector("#export-form")).get(
        "format",
      );
    const execution = clone(state.exportExecution);
    document.querySelector("#export-progress").innerHTML = notice(
      `<span class="pulse"></span> 正在组织 ${format} 内容，复用当前结果…`,
    );
    button.disabled = true;
    setTimeout(() => {
      if (!dialog.open || token !== dialogToken) return;
      const failed = state.reportScenario === "export_failed";
      document.querySelector("#export-progress").innerHTML = failed
        ? notice("模拟生成失败。结果已保留，可以重新选择格式后再试。", "error")
        : notice(
            `<strong>${format} 生成流程演示完成</strong><br>${months[execution.month]} · 定义 v${execution.definitionVersion} · 快照 v${execution.snapshotVersion}<br>内容包含查询条件、${resultRows(execution).length} 行结果和数据时间。此原型不产生实际下载文件。`,
            "success",
          );
      button.disabled = false;
      if (failed) {
        state.reportScenario = "normal";
        button.textContent = "重试生成流程";
      } else button.textContent = "重新演示";
    }, 900);
  }

  function resourceForm(isNew = false) {
    const isAgent = state.adminTab === "agents";
    const resource = isAgent
      ? state.agents[state.selectedResource].definition
      : state.models[state.selectedResource];
    const nextVersion = isNew ? 1 : resource.version + 1;
    state.resourceEditing = {
      isNew,
      isAgent,
      index: state.selectedResource,
      version: nextVersion,
    };
    const tools = ["read_skill_reference", "search_catalog", "query_metric"];
    const content = `<form id="resource-form" class="form-grid"><div class="field"><label for="resource-name">${isAgent ? "Agent 名称" : "配置显示名称"}</label><input id="resource-name" name="name" value="${isNew ? "" : escape(resource.name)}" required maxlength="200"/></div><div class="field"><label for="resource-id">资源标识</label><input id="resource-id" name="id" value="${isNew ? "" : escape(isAgent ? resource.agent_id : resource.model_id)}" ${isNew ? "required" : "readonly"} maxlength="128" placeholder="例如 demo-analysis"/></div>
      ${isAgent ? `<div class="field span-2"><label for="resource-description">分析职责</label><textarea id="resource-description" name="description" rows="2" maxlength="2000">${isNew ? "" : escape(resource.description)}</textarea></div><div class="field"><label for="resource-model">绑定模型版本</label><select id="resource-model" name="model">${state.models.flatMap((model) => model.history.map((version) => `<option value="${escape(model.model_id)}|${version}" ${model.model_id === resource.model_id && version === resource.model_version ? "selected" : ""}>${escape(model.name)} · v${version}</option>`)).join("")}</select></div><div class="field"><label for="resource-timeout">单轮超时（秒）</label><input id="resource-timeout" name="timeout" type="number" min="1" max="600" value="${resource.limits.timeout_ms / 1000}" required/></div><div class="field"><label for="resource-calls">最多工具调用次数</label><input id="resource-calls" name="calls" type="number" min="1" max="100" value="${resource.limits.max_tool_calls}" required/></div><div class="field"><label for="resource-context">输入容量（字节）</label><input id="resource-context" name="context" type="number" min="4096" max="1048576" value="${resource.limits.max_context_bytes}" required/></div><fieldset><legend>工具</legend>${tools.map((name) => `<label class="check-option"><input name="tools" type="checkbox" value="${name}" ${resource.tool_names.includes(name) ? "checked" : ""}/><span class="mono">${name}</span></label>`).join("")}</fieldset><fieldset><legend>Skills</legend>${["query-analysis", "query-dsl"].map((name) => `<label class="check-option"><input name="skills" type="checkbox" value="${name}" ${resource.skill_names.includes(name) ? "checked" : ""}/><span>${name}</span></label>`).join("")}</fieldset>` : `<div class="field span-2"><label for="model-url">模型服务地址</label><input id="model-url" name="url" type="url" required value="${isNew ? "https://model.example.invalid/v1" : escape(resource.base_url)}"/></div><div class="field"><label for="model-name">服务端模型名称</label><input id="model-name" name="model" value="${isNew ? "" : escape(resource.model)}" required maxlength="200"/></div><div class="field"><label for="model-window">上下文容量</label><input id="model-window" name="window" type="number" min="4096" max="2097152" required value="${resource.context_window}"/></div><div class="field"><label for="model-auth">认证方式</label><select id="model-auth" name="auth" data-change="model-auth"><option value="key">API Key</option><option value="none">无需认证</option></select></div><div class="field"><label for="model-key">当前版本的 API Key</label><input id="model-key" name="key" type="password" autocomplete="off" placeholder="仅输入虚构测试值" required/><small>每个版本单独配置，旧凭据不会自动填入。</small></div><div class="span-2">${notice("请使用虚构地址与测试值。原型仅保留公开的认证配置状态。")}</div>`}</form><div id="resource-error" class="field-error" role="alert"></div><div id="resource-retry"></div>`;
    openDialog(
      `${isNew ? "新建" : "发布新版本 ·"} ${isAgent ? "Agent" : "模型"}`,
      content,
      `<small>即将发布 v${nextVersion}</small>${btn("取消", "close-dialog")}<button class="btn primary" type="submit" form="resource-form">发布 v${nextVersion}</button>`,
      true,
    );
  }

  function publishResource(form) {
    const input = new FormData(form),
      editing = state.resourceEditing;
    const error = document.querySelector("#resource-error");
    if (state.adminScenario === "failed") {
      error.textContent = "模拟发布失败：服务暂时不可用。你填写的内容已保留。";
      document.querySelector("#resource-retry").innerHTML =
        `<div class="m-top">${btn("模拟服务恢复后重试", "recover-publish")}</div>`;
      return;
    }
    const name = input.get("name").trim(),
      id = input.get("id").trim();
    const items = editing.isAgent ? state.agents : state.models;
    if (!name || !id) {
      error.textContent = "名称和资源标识不能为空。";
      return;
    }
    if (
      editing.isNew &&
      items.some(
        (entry) =>
          (editing.isAgent ? entry.definition.agent_id : entry.model_id) === id,
      )
    ) {
      error.textContent = "该资源标识已存在，请填写新的标识。";
      return;
    }
    if (editing.isAgent) {
      const toolNames = input.getAll("tools"),
        skillNames = input.getAll("skills");
      if (skillNames.length && !toolNames.includes("read_skill_reference")) {
        error.textContent =
          "绑定 Skill 时，请启用 read_skill_reference 子文档读取工具。";
        return;
      }
      const [modelId, modelVersion] = input.get("model").split("|");
      const definition = {
        ...clone(data.agent),
        agent_id: id,
        version: editing.version,
        name,
        description: input.get("description").trim(),
        model_id: modelId,
        model_version: Number(modelVersion),
        tool_names: toolNames,
        skill_names: skillNames,
        limits: {
          timeout_ms: Number(input.get("timeout")) * 1000,
          max_tool_calls: Number(input.get("calls")),
          max_context_bytes: Number(input.get("context")),
        },
      };
      if (editing.isNew) {
        state.agents.push({
          definition,
          enabled: true,
          history: [1],
          snapshots: { 1: clone(definition) },
        });
        state.selectedResource = state.agents.length - 1;
      } else {
        const entry = state.agents[editing.index];
        entry.definition = definition;
        entry.history.push(editing.version);
        entry.snapshots[editing.version] = clone(definition);
      }
    } else {
      let url;
      try {
        url = new URL(input.get("url"));
      } catch {
        error.textContent = "请填写有效的模型服务地址。";
        return;
      }
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        error.textContent = "地址须使用 HTTP(S)，认证请填写到独立字段。";
        return;
      }
      const model = {
        ...clone(data.model),
        model_id: id,
        version: editing.version,
        name,
        base_url: url.href,
        model: input.get("model").trim(),
        context_window: Number(input.get("window")),
        has_api_key: input.get("auth") === "key" && Boolean(input.get("key")),
        history: editing.isNew
          ? [1]
          : [...state.models[editing.index].history, editing.version],
      };
      if (editing.isNew) {
        model.snapshots = { 1: clone(model) };
        state.models.push(model);
        state.selectedResource = state.models.length - 1;
      } else {
        model.enabled = state.models[editing.index].enabled;
        model.snapshots = state.models[editing.index].snapshots;
        model.snapshots[editing.version] = clone({
          ...model,
          snapshots: undefined,
        });
        state.models[editing.index] = model;
      }
    }
    state.adminScenario = "normal";
    closeDialog();
    render();
    toast(`${name} v${editing.version} 已发布（模拟）`);
  }

  function versionDetail(version) {
    const isAgent = state.adminTab === "agents",
      entry = (isAgent ? state.agents : state.models)[state.selectedResource];
    const record = entry.snapshots[version];
    openDialog(
      `版本 v${version}`,
      `<p class="modal-note">发布后固定的配置记录，使用该版本的会话继续沿用其配置。</p><dl class="definition-list"><dt>名称</dt><dd>${escape(record.name)}</dd><dt>版本</dt><dd>v${version}</dd>${isAgent ? `<dt>绑定模型</dt><dd>${escape(record.model_id)} · v${record.model_version}</dd><dt>分析职责</dt><dd>${escape(record.description)}</dd><dt>工具</dt><dd>${record.tool_names.map(escape).join("、")}</dd><dt>Skills</dt><dd>${record.skill_names.map(escape).join("、")}</dd><dt>执行预算</dt><dd>${record.limits.timeout_ms / 1000} 秒 · ${record.limits.max_tool_calls} 次工具调用</dd>` : `<dt>模型名称</dt><dd>${escape(record.model)}</dd><dt>服务地址</dt><dd class="mono">${escape(record.base_url)}</dd><dt>API Key</dt><dd>${record.has_api_key ? "已配置" : "未配置"}</dd>`}</dl>`,
      btn("关闭", "close-dialog", "primary"),
    );
  }

  /* 历史快照是独立副本，发布新版本不会修改已有演示记录。 */
  state.agents.forEach((entry) => {
    entry.snapshots = Object.fromEntries(
      entry.history.map((version) => [
        version,
        { ...clone(entry.definition), version },
      ]),
    );
  });
  state.models.forEach((entry) => {
    entry.snapshots = Object.fromEntries(
      entry.history.map((version) => [version, { ...clone(entry), version }]),
    );
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (event.target.closest(".skip-link")) {
      event.preventDefault();
      document.querySelector("#main-content").focus();
      return;
    }
    if (!button || button.disabled) return;
    if (button.dataset.page) {
      navigate(button.dataset.page);
      return;
    }
    if (button.dataset.chart) {
      state.chartMode = button.dataset.chart;
      render();
      return;
    }
    if (button.dataset.adminTab) {
      state.adminTab = button.dataset.adminTab;
      state.selectedResource = 0;
      render();
      return;
    }
    if (button.dataset.resource !== undefined) {
      state.selectedResource = Number(button.dataset.resource);
      render();
      return;
    }
    if (button.dataset.editor) {
      captureDraft();
      editReport(button.dataset.editor);
      return;
    }
    if (button.dataset.followup) {
      document.querySelector("#question").value = button.dataset.followup;
      document.querySelector("#question").focus();
      return;
    }
    const action = button.dataset.action;
    if (!action) return;
    if (action === "close-dialog") closeDialog();
    else if (action === "menu") {
      state.menu = !state.menu;
      render();
    } else if (action === "scenarios") scenarios();
    else if (action === "page-map") pageMap();
    else if (action.startsWith("go-")) {
      closeDialog();
      navigate(action.slice(3));
    } else if (action === "evidence") evidence();
    else if (action === "new-chat" || action === "example-chat") {
      state.runToken += 1;
      state.chat = "empty";
      state.question = "";
      navigate("analysis");
    } else if (action === "existing-chat") {
      state.runToken += 1;
      state.boundAgent = clone(data.agent);
      state.chat = "completed";
      state.question = "8 月门诊量相比上月有什么变化？按科室看看。";
      navigate("analysis");
    } else if (action === "sample-question") {
      document.querySelector("#question").value =
        "8 月门诊量相比上月有什么变化？按科室看看。";
      document.querySelector("#question").focus();
    } else if (action === "clarify") {
      state.clarification = data.clarification.options.find(
        (option) => option.id === button.dataset.option,
      ).label;
      runChat();
    } else if (action === "cancel-run") {
      state.runToken += 1;
      state.chat = "cancelled";
      render();
      toast("本次分析已取消");
    } else if (action === "restart-run") runChat();
    else if (action === "edit-question") {
      document.querySelector("#question").value = state.question;
      document.querySelector("#question").focus();
    } else if (action === "save-report") {
      navigate("report");
      toast("已打开本次分析对应的示例报表");
    } else if (action === "previous-page" || action === "next-page") {
      state.tablePage += action === "next-page" ? 1 : -1;
      render();
    } else if (action === "edit-report") editReport();
    else if (action === "save-definition") saveDefinition();
    else if (action === "resolve-conflict") {
      state.draft.expectedVersion = state.definitionVersion;
      editReport(state.editorMode);
    } else if (action === "preview-revision") {
      state.draft.title = "门诊量与科室结构分析";
      editReport("form");
      toast("已将示例修改放入草稿，请确认后保存");
    } else if (action === "share") shareReport();
    else if (action === "save-sharing") {
      state.shares = [
        ...dialog.querySelectorAll('[name="share-user"]:checked'),
      ].map((input) => input.value);
      state.definitionVersion += 1;
      closeDialog();
      render();
      toast(`分享已保存，当前定义 v${state.definitionVersion}`);
    } else if (action === "export") exportDialog();
    else if (action === "generate-export") generateExport(button);
    else if (action === "narrate")
      openDialog(
        "为当前执行生成分析说明",
        `<p class="modal-note">说明将绑定 ${escape(currentExecution().id)}，保留本次参数与结果。真实模型生成在后续接口接入阶段完成。</p>${notice("本轮提供入口与执行归属展示。")}`,
        btn("关闭", "close-dialog", "primary"),
      );
    else if (action === "new-resource") resourceForm(true);
    else if (action === "publish-resource") resourceForm(false);
    else if (action === "recover-publish") {
      state.adminScenario = "normal";
      document.querySelector("#resource-form").requestSubmit();
    } else if (action === "version-detail")
      versionDetail(Number(button.dataset.version));
    else if (action === "toggle-resource") {
      const entry = (state.adminTab === "agents" ? state.agents : state.models)[
        state.selectedResource
      ];
      openDialog(
        entry.enabled ? "停用配置" : "启用配置",
        `<p class="modal-note">${entry.enabled ? "停用后，新分析无法使用此配置；历史配置与结果保留。" : "启用后，可以在新的分析中选择此配置。"}</p>`,
        btn("取消", "close-dialog") +
          btn(
            entry.enabled ? "确认停用" : "确认启用",
            "confirm-toggle",
            "primary",
          ),
      );
    } else if (action === "confirm-toggle") {
      const entry = (state.adminTab === "agents" ? state.agents : state.models)[
        state.selectedResource
      ];
      entry.enabled = !entry.enabled;
      closeDialog();
      render();
      toast(entry.enabled ? "配置已启用（模拟）" : "配置已停用（模拟）");
    } else if (action === "set-scenario") {
      const scenario = button.dataset.scenario;
      if (state.page === "analysis") {
        state.runToken += 1;
        state.chat = scenario;
        if (!state.question)
          state.question = "8 月门诊量相比上月有什么变化？按科室看看。";
      } else if (state.page === "report") {
        state.reportScenario = scenario;
        state.reportError = "";
      } else state.adminScenario = scenario;
      closeDialog();
      render();
      toast(`已切换：${button.textContent.trim()}`);
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    event.preventDefault();
    if (form.getAttribute("id") === "chat-form") {
      if (["running", "clarification"].includes(state.chat)) return;
      const question = new FormData(form).get("question").trim();
      if (!question) {
        toast("请先输入分析问题");
        return;
      }
      if (state.chat === "empty") {
        const entry = state.agents.find(
          (item) =>
            item.enabled &&
            item.definition.agent_id === new FormData(form).get("agent"),
        );
        if (!entry) {
          toast("请先启用一个 Agent");
          return;
        }
        state.boundAgent = clone(entry.definition);
      }
      state.question = question;
      state.chat = "clarification";
      render();
    } else if (form.getAttribute("id") === "clarification-form") {
      const value = new FormData(form).get("answer").trim();
      if (!value) return;
      state.clarification = value;
      runChat();
    } else if (form.getAttribute("id") === "report-form") {
      if (state.executing) return;
      const parameters = clone(state.parameters),
        version = state.definitionVersion;
      state.executing = true;
      state.reportError = "";
      render();
      setTimeout(() => {
        state.executing = false;
        if (state.reportScenario === "failed")
          state.reportError =
            "模拟执行失败：数据源暂时不可用。已保留你选择的参数和上次结果。";
        else {
          const next = state.executions.length + 1;
          state.executions.push({
            ...parameters,
            id: `demo-execution-${String(next).padStart(3, "0")}`,
            definitionVersion: version,
            snapshotVersion: next,
            time: "2026-09-27 10:30:00",
          });
          state.executionIndex = next - 1;
          state.tablePage = 1;
          toast("报表运行完成（模拟），已生成新快照");
        }
        render();
      }, 1100);
    } else if (form.getAttribute("id") === "resource-form")
      publishResource(form);
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "edit-title") captureDraft();
  });
  document.addEventListener("change", (event) => {
    const element = event.target,
      action = element.dataset.change;
    if (action === "page-size") {
      state.pageSize = Number(element.value);
      state.tablePage = 1;
      render();
    } else if (action === "report-month") {
      state.parameters.month = element.value;
      render();
    } else if (action === "report-department") {
      state.parameters.department = element.value;
      render();
    } else if (action === "execution") {
      state.executionIndex = Number(element.value);
      state.tablePage = 1;
      render();
    } else if (action === "model-auth") {
      const key = document.querySelector("#model-key");
      key.required = element.value === "key";
      key.disabled = element.value !== "key";
      if (key.disabled) key.value = "";
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      event.target.id === "question" &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      document.querySelector("#chat-form").requestSubmit();
    }
    if (event.key === "Escape" && state.menu && !dialog.open) {
      state.menu = false;
      render();
    }
  });
  dialog.addEventListener("close", () => {
    dialogToken += 1;
    if (lastFocus?.isConnected) lastFocus.focus();
    else
      document.querySelector("#main-content")?.focus({ preventScroll: true });
  });
  window.addEventListener("hashchange", () => {
    state.page = ["analysis", "report", "settings"].includes(
      location.hash.slice(1),
    )
      ? location.hash.slice(1)
      : "analysis";
    state.tablePage = 1;
    render();
    window.scrollTo({ top: 0 });
  });
  render();
})();
