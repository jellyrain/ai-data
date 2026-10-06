import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ResourceList from "../../../src/shared/management/resource-list.vue";

describe("管理资源分页", () => {
  it("刷新后资源减少时回到有效页，剩余对象仍可见", async () => {
    const wrapper = mount(ResourceList, {
      props: { items: Array.from({ length: 25 }, (_, i) => ({ id: `${i}`, title: `模型${i}` })) },
    });
    await wrapper.get(".btn-next").trigger("click");
    expect(wrapper.text()).toContain("模型24");
    await wrapper.setProps({ items: [{ id: "0", title: "剩余模型" }] });
    expect(wrapper.findAll(".management-resource")).toHaveLength(1);
    expect(wrapper.text()).toContain("剩余模型");
    wrapper.unmount();
  });
});
