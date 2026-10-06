import { defineStore } from "pinia";
/** 窄屏导航状态随身份切换清理。 */
const useLayoutStore = defineStore("layout", {
  state: () => ({ navigationOpen: false, canvas: false }),
});
export { useLayoutStore };
