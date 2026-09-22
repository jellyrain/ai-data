import { defineConfig } from "vitepress";
import { fileURLToPath } from "node:url";
import { createRewrites } from "vitepress-theme-teek/config";
import llmstxt from "vitepress-plugin-llms";
import { teekConfig } from "./teekConfig";

const description = [
  "AI BI 项目说明：指南、API、开发、部署运维、使用、管理与归档记录",
].toString();

// https://vitepress.dev/reference/site-config
export default defineConfig({
  extends: teekConfig,
  rewrites: createRewrites({
    srcDir: fileURLToPath(new URL("../", import.meta.url)),
  }),
  title: "AI BI",
  description: description,
  cleanUrls: false,
  lastUpdated: true,
  lang: "zh-CN",
  head: [
    // [
    //   "link",
    //   { rel: "icon", type: "image/svg+xml", href: "/teek-logo-mini.svg" },
    // ],
    ["link", { rel: "icon", type: "image/png", href: "/logo.png" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:locale", content: "zh-CN" }],
    ["meta", { property: "og:title", content: "AI BI 文档" }],
    ["meta", { property: "og:site_name", content: "AI BI" }],
    ["meta", { property: "og:image", content: "" }],
    ["meta", { property: "og:url", content: "" }],
    ["meta", { property: "og:description", content: description }],
    ["meta", { name: "description", content: description }],
    ["meta", { name: "author", content: "JellyRain" }],
    // 禁止浏览器缩放
    // [
    //   "meta",
    //   {
    //     name: "viewport",
    //     content: "width=device-width,initial-scale=1,minimum-scale=1.0,maximum-scale=1.0,user-scalable=no",
    //   },
    // ],
    ["meta", { name: "keywords", content: description }],
  ],
  markdown: {
    // 开启行号
    lineNumbers: true,
    image: {
      // 默认禁用；设置为 true 可为所有图片启用懒加载。
      lazyLoading: true,
    },
    // 更改容器默认值标题
    container: {
      tipLabel: "提示",
      warningLabel: "警告",
      dangerLabel: "危险",
      infoLabel: "信息",
      detailsLabel: "详细信息",
    },
  },
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: "/logo.png",
    darkModeSwitchLabel: "主题",
    sidebarMenuLabel: "菜单",
    returnToTopLabel: "返回顶部",
    lastUpdatedText: "上次更新时间",
    outline: {
      level: [2, 4],
      label: "本页导航",
    },
    docFooter: {
      prev: "上一页",
      next: "下一页",
    },
    nav: [
      { text: "首页", link: "/" },
      { text: "指南", link: "/guide", activeMatch: "^/(guide|01\\.指南)" },
      { text: "API 参考", link: "/api", activeMatch: "^/(api|02\\.API)" },
      {
        text: "开发指南",
        link: "/develop",
        activeMatch: "^/(develop|03\\.开发)",
      },
      {
        text: "部署运维",
        link: "/deployment",
        activeMatch: "^/(deployment|04\\.部署运维)",
      },
      {
        text: "使用手册",
        link: "/manual",
        activeMatch: "^/(manual|05\\.使用手册)",
      },
      {
        text: "管理手册",
        link: "/admin",
        activeMatch: "^/(admin|06\\.管理手册)",
      },
      {
        text: "归档记录",
        link: "/changelog/updates",
        activeMatch: "^/(changelog|07\\.归档记录)",
      },
    ],
    search: {
      provider: "local",
    },
  },
  vite: {
    plugins: [llmstxt() as any],
  },
  // transformHtml: (code, id, context) => {
  //   if (context.page !== "404.md") return code;
  //   return code.replace("404 | ", "");
  // },
});
