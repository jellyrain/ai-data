import { ApplicationError } from "../errors/application-error";

/** Agent 可收窄模型预算；服务实际窗口是上限，预留四分之一用于后续生成与回包。 */
function contextBudget(input: {
  serviceWindow?: number;
  modelWindow?: number;
  agentWindow?: number;
}) {
  const configured = input.agentWindow ?? input.modelWindow;
  const contextWindow = Math.min(input.serviceWindow ?? Infinity, configured ?? Infinity);
  if (!Number.isInteger(contextWindow) || contextWindow < 4096 || contextWindow > 2097152)
    throw new ApplicationError(
      "INVALID_INPUT",
      "无法确定模型实际上下文窗口，请配置模型 context_window 或检查模型能力接口",
    );
  const contextWindowSource =
    input.serviceWindow !== undefined &&
    (configured === undefined || input.serviceWindow <= configured)
      ? "service"
      : input.agentWindow !== undefined
        ? "agent"
        : "model";
  return {
    contextWindow,
    autoCompactTokenLimit: Math.floor(contextWindow * 0.75),
    contextWindowSource,
  };
}

export { contextBudget };
