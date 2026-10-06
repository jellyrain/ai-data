import type { ObjectDirective } from "vue";

/** 当前数字组件只在挂载时写入范围和禁用状态；按实际原生属性同步辅助信息。 */
function synchronize(element: HTMLElement) {
  const input = element.querySelector("input");
  if (!input) return;
  input.setAttribute("aria-disabled", String(input.disabled));
  for (const bound of ["min", "max"] as const) {
    if (input[bound]) input.setAttribute(`aria-value${bound}`, input[bound]);
    else input.removeAttribute(`aria-value${bound}`);
  }
}

/** 限定于本轮管理表单，保留组件原有校验、步进与表单禁用行为。 */
const vNumberAccessibility: ObjectDirective<HTMLElement> = {
  mounted: synchronize,
  updated: synchronize,
};
export { vNumberAccessibility };
