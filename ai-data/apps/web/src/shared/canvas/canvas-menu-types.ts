/** 菜单动作由所属画布执行；共享组件负责定位、键盘操作与关闭。 */
type CanvasMenuAction = { id: string; label: string; disabled?: boolean; checked?: boolean };
export type { CanvasMenuAction };
