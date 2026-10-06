import { inject } from "vue";
import { QueryClient } from "@tanstack/vue-query";
import { AuthSession } from "../features/auth/stores/auth-session";
import { createTransport } from "../shared/http/transport";
import { ThemeController } from "../shared/theme/theme";
import { SessionResources } from "../shared/session/session-resources";
import { servicesKey } from "./services-key";
import type { AppServices } from "./services-types";
import type { Transport } from "../shared/http/http-types";
import { openEventStream } from "../shared/stream/stream-transport";
import { AnalysisWorkspace } from "../features/analysis/stores/analysis-workspace";
import { ReportWorkspace } from "../features/reports/stores/report-workspace";
import { ReportNarratives } from "../features/reports/stores/report-narratives";
import { ReportEditor } from "../features/reports/stores/report-editor";
import { ReportRevisions } from "../features/reports/stores/report-revisions";
import { ReportSharingController } from "../features/reports/stores/report-sharing";

/** 建立浏览器服务；身份通知仅携带事件名，令牌保留在各页内存。 */
function createServices(): AppServices {
  const query = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const resources = new SessionResources();
  resources.register(() => {
    void query.cancelQueries();
    query.clear();
  });
  const transport = createTransport();
  const channel =
    typeof BroadcastChannel === "function" ? new BroadcastChannel("ai-data.identity.v1") : null;
  const auth = new AuthSession({
    transport,
    reset: () => resources.reset(),
    coordinate: (operation) =>
      navigator.locks ? navigator.locks.request("ai-data.identity.v1", operation) : operation(),
    publish: (event) => channel?.postMessage(event),
  });
  if (channel)
    channel.onmessage = (event) => {
      if (event.data === "changed" || event.data === "logout") void auth.receive(event.data);
    };
  const theme = new ThemeController();
  const request: Transport = (path, options) =>
    resources.run((signal) =>
      auth.request((token) =>
        transport(path, {
          ...options,
          token,
          signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
        }),
      ),
    );
  const dependencies = {
    request,
    resources,
    identity: () => auth.state.context,
    stream: (path: string, cursor: number, signal: AbortSignal) =>
      auth.request((token) => openEventStream(path, token, cursor, signal)),
  };
  const analysis = new AnalysisWorkspace(dependencies);
  const reports = new ReportWorkspace(dependencies);
  const reportEditor = new ReportEditor(dependencies);
  const reportSharing = new ReportSharingController({
    ...dependencies,
    changed: () => reports.refreshHistory(),
  });
  const reportRevisions = new ReportRevisions({
    ...dependencies,
    lock: (value) => {
      reportEditor.state.locked = value;
    },
    commit: (version) => reportEditor.acceptRevision(version),
    onDenied: (message) => {
      reportEditor.leave();
      reportEditor.state.error = message;
    },
  });
  const reportNarratives = new ReportNarratives({
    ...dependencies,
    onDenied: (message) => {
      reports.leave();
      reports.state.resultError = message;
    },
  });
  return {
    auth,
    theme,
    query,
    resources,
    analysis,
    reports,
    reportNarratives,
    reportEditor,
    reportRevisions,
    reportSharing,
    request,
    dispose: () => {
      channel?.close();
      theme.dispose();
      analysis.dispose();
      reports.dispose();
      reportNarratives.dispose();
      reportEditor.dispose();
      reportRevisions.dispose();
      reportSharing.dispose();
      resources.reset();
    },
  };
}
/** 组件只访问当前应用实例，不共享模块级身份单例。 */
function useServices(): AppServices {
  const services = inject(servicesKey);
  if (!services) throw new Error("应用服务尚未初始化");
  return services;
}
export { createServices, useServices };
