import { createApp, h } from "vue";
import { ElConfigProvider } from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { createPinia } from "pinia";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./app.vue";
import { createServices } from "./app/services";
import { servicesKey } from "./app/services-key";
import { createAppRouter } from "./app/router";
import "element-plus/theme-chalk/base.css";
import "element-plus/theme-chalk/el-button.css";
import "element-plus/theme-chalk/el-input.css";
import "element-plus/theme-chalk/el-form.css";
import "element-plus/theme-chalk/el-form-item.css";
import "element-plus/theme-chalk/el-alert.css";
import "element-plus/theme-chalk/el-popover.css";
import "element-plus/theme-chalk/el-popper.css";
import "element-plus/theme-chalk/el-drawer.css";
import "element-plus/theme-chalk/el-overlay.css";
import "element-plus/theme-chalk/el-select.css";
import "element-plus/theme-chalk/el-option.css";
import "element-plus/theme-chalk/el-scrollbar.css";
import "element-plus/theme-chalk/el-table-v2.css";
import "element-plus/theme-chalk/el-pagination.css";
import "element-plus/theme-chalk/el-skeleton.css";
import "element-plus/theme-chalk/el-skeleton-item.css";
import "element-plus/theme-chalk/el-input-number.css";
import "element-plus/theme-chalk/el-checkbox.css";
import "element-plus/theme-chalk/el-checkbox-group.css";
import "element-plus/theme-chalk/el-radio.css";
import "element-plus/theme-chalk/el-radio-group.css";
import "element-plus/theme-chalk/el-dialog.css";
import "element-plus/theme-chalk/el-date-picker.css";
import "element-plus/theme-chalk/el-dropdown.css";
import "element-plus/theme-chalk/el-tag.css";
import "element-plus/theme-chalk/el-tabs.css";
import "element-plus/theme-chalk/el-message-box.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import "./styles/theme.css";
import "./styles/controls.css";
import "./styles/app.css";
import "./styles/analysis.css";
import "./styles/content.css";
import "./styles/reports.css";
import "./styles/report-editor.css";
import "./styles/management.css";
import "./features/knowledge/knowledge.css";

const services = createServices();
const router = createAppRouter(services.auth);
createApp({ setup: () => () => h(ElConfigProvider, { locale: zhCn }, () => h(App)) })
  .provide(servicesKey, services)
  .use(createPinia())
  .use(VueQueryPlugin, { queryClient: services.query })
  .use(router)
  .mount("#app");
if (import.meta.hot) import.meta.hot.dispose(() => services.dispose());
