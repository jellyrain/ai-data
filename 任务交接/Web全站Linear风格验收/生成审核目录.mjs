import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = fileURLToPath(new URL(".", import.meta.url));
const names = (await readdir(directory)).filter((name) => name.endsWith(".png")).sort();
const items = await Promise.all(names.map(async (name) => {
  const bytes = await readFile(path.join(directory, name));
  if (bytes.subarray(1, 4).toString() !== "PNG") throw new Error(`图片格式异常：${name}`);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const number = Number(name.slice(0, 2));
  const group = number === 30 || number === 31 ? "适配" : number <= 5 ? "登录与分析" : number <= 19 ? "报表" : "管理与知识";
  return { name, title: name.replace(/\.png$/, ""), width, height, group };
}));
const desktop = items.filter((item) => item.group !== "适配");
if (desktop.length !== 30 || desktop.some((item) => item.width !== 1920 || item.height !== 1080)) {
  throw new Error(`应有 30 张 1920×1080 桌面截图，当前 ${desktop.length} 张`);
}
if (items.length !== 34) throw new Error(`应有 34 张截图，当前 ${items.length} 张`);
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const figures = items.map((item) => `<article data-group="${item.group}" data-title="${escape(item.title)}">
  <a href="${encodeURIComponent(item.name)}" target="_blank" rel="noopener"><img src="${encodeURIComponent(item.name)}" alt="${escape(item.title)}" loading="lazy" width="${item.width}" height="${item.height}"></a>
  <div><h2>${escape(item.title)}</h2><span>${item.width} × ${item.height}</span></div>
</article>`).join("\n");
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Web 全站页面审核</title>
<style>
:root{color-scheme:dark;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#17181b;color:#eceef2}
*{box-sizing:border-box}body{margin:0;padding:48px max(24px,4vw)}header{max-width:1000px}h1{font-size:28px;font-weight:600;margin:0 0 12px}p{color:#a9adb7;line-height:1.8;font-size:14px;margin:8px 0}a{color:#bda2f0;text-underline-offset:4px}nav{display:flex;gap:8px;flex-wrap:wrap;margin:28px 0 24px;border-bottom:1px solid #32353e;padding-bottom:18px}button,input{font:inherit;font-size:13px;color:inherit;background:#202227;border:1px solid #505560;border-radius:5px;padding:8px 12px}button{cursor:pointer}button[aria-pressed=true]{border-color:#bda2f0;color:#bda2f0}input{margin-left:auto;max-width:100%}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #bda2f0;outline-offset:3px}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px 24px}article{min-width:0}article>a{display:block;border:1px solid #32353e;border-radius:7px;overflow:hidden;background:#121316}img{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:contain}article>div{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}h2{font-size:14px;font-weight:500;margin:0}span,output{color:#a9adb7;font-size:12px}output{display:block;margin-bottom:18px}[hidden]{display:none!important}footer{margin-top:40px;border-top:1px solid #32353e;padding-top:16px}@media(max-width:760px){body{padding:28px 18px}main{grid-template-columns:1fr}input{margin-left:0;width:100%}}
</style></head><body>
<header><h1>Web 全站页面审核</h1><p>Linear 风格 · 30 张桌面截图（1920 × 1080）· 4 张适配截图</p><p>截图来自实际 Web 页面，使用隔离验收数据。点击图片可打开原图；长表单截取首屏，完整操作由浏览器回归验证。</p><p><a href="../Web全站Linear风格交付说明.md">交付说明与流程图</a> · <a href="截图清单.json">尺寸与文件清单</a></p></header>
<nav aria-label="页面分类">${["全部", "登录与分析", "报表", "管理与知识", "适配"].map((label) => `<button type="button" aria-pressed="${label === "全部"}" data-filter="${label}">${label}</button>`).join("")}<input type="search" aria-label="搜索页面" placeholder="搜索页面名称"></nav>
<output aria-live="polite">显示 34 张截图</output><main>${figures}</main><footer><p>主要展示暗色 · 紫罗兰；登录、报表详情、筛选编辑、业务目录附亮色图。应用继续支持四种配色及跟随系统。</p></footer>
<script>
let group='全部';const search=document.querySelector('input');
function filter(){let count=0;document.querySelectorAll('article').forEach(item=>{const show=(group==='全部'||item.dataset.group===group)&&item.dataset.title.toLowerCase().includes(search.value.trim().toLowerCase());item.hidden=!show;if(show)count++});document.querySelector('output').textContent='显示 '+count+' 张截图'}
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{group=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));filter()}));search.addEventListener('input',filter);
</script></body></html>`;
await writeFile(path.join(directory, "审核.html"), html);
await writeFile(path.join(directory, "截图清单.json"), JSON.stringify({ source: "实际 Web + 隔离验收数据", desktop: desktop.length, responsive: items.length - desktop.length, items }, null, 2) + "\n");
console.log(`审核目录已生成：${desktop.length} 张桌面截图，${items.length - desktop.length} 张适配截图。`);
