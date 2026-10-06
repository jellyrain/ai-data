import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(directory, 'screenshots.json'), 'utf8'));
const shots = manifest.screenshots;
if (manifest.failures.length || manifest.pageErrors.length) throw new Error('先完成截图检查');
for (const item of shots) {
  const png = await readFile(path.join(directory, item.file));
  if (png.readUInt32BE(16) !== 1920 || png.readUInt32BE(20) !== 1080) throw new Error(item.file + ' 比例不符');
}
const esc = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const modules = [...new Set(shots.map(item => item.module))];
const intro = '当前 Web 生产构建的浏览器截图，使用隔离验收数据。统一 1920 × 1080、100% 浏览器缩放、原始字号。长页面按滚动位置分别取景。';
const cards = shots.map(item => `<article data-module="${esc(item.module)}"><a class="shot" href="${esc(item.file)}" data-id="${item.id}"><img loading="lazy" src="${esc(item.file)}" alt="${esc(item.title)}" width="1920" height="1080"></a><div class="caption"><span class="number">${item.id}</span><div><h2>${esc(item.title)}</h2><p>${esc(item.module)}${item.theme === 'dark' ? ' · 暗色' : ''}</p></div><a class="original" href="${esc(item.file)}" target="_blank" rel="noopener">原图 ↗</a></div>${item.note ? `<p class="note">${esc(item.note)}</p>` : ''}</article>`).join('\n');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Data · 页面审核</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f1;color:#25291e;font-family:"Microsoft YaHei",system-ui,sans-serif}header,main{max-width:1680px;margin:auto;padding:32px 40px}header{padding-bottom:16px}small{color:#686e53;letter-spacing:.1em}h1{font-size:32px;letter-spacing:-.03em;margin:14px 0}header p{line-height:1.8;color:#626857;max-width:1100px;margin:10px 0}.bar{display:flex;align-items:center;gap:14px;margin-top:22px;padding:16px 0;border-top:1px solid #d9ddce}select,button{font:inherit;border:1px solid #c9cfbc;border-radius:6px;background:white;color:inherit;padding:9px 13px}select{min-width:190px}button{cursor:pointer}a{color:inherit}main{padding-top:12px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}article{border:1px solid #d9ddce;border-radius:9px;overflow:hidden;background:#fff}article[hidden]{display:none}.shot{display:block;background:#e8eadf}.shot img{width:100%;height:auto;display:block;aspect-ratio:16/9;object-fit:contain}.shot:hover{outline:3px solid #727638;outline-offset:-3px}.caption{display:flex;align-items:center;padding:17px 20px;gap:13px;border-top:1px solid #e0e3d6}.number{font:600 20px ui-monospace,monospace;color:#777d61;min-width:39px}h2{font-size:17px;margin:0 0 6px}.caption p{font-size:13px;color:#777d6d;margin:0}.original{margin-left:auto;white-space:nowrap;font-size:13px}.note{margin:0;padding:0 20px 17px;color:#777d6d;font-size:13px;line-height:1.6}dialog{padding:0;border:0;width:min(98vw,1960px);max-width:none;max-height:97vh;background:#171b16;color:#fff;border-radius:8px}dialog::backdrop{background:#131811dd}.viewerbar{display:flex;align-items:center;gap:10px;padding:12px 18px;position:sticky;top:0;background:#171b16}.viewerbar strong{flex:1}.viewerbar button{background:#292f24;color:white;border-color:#525b45}.viewerbar a{padding:0 10px}#full{display:block;width:100%;max-height:calc(97vh - 65px);object-fit:contain}footer{padding:30px 40px;color:#777d6d;text-align:center;font-size:13px}button:focus-visible,a:focus-visible,select:focus-visible{outline:3px solid #91985d;outline-offset:3px}@media(max-width:820px){header,main{padding-left:18px;padding-right:18px}.grid{grid-template-columns:1fr}.viewerbar{flex-wrap:wrap}.viewerbar strong{width:100%;flex-basis:100%}h1{font-size:25px}}
</style><header><small>AI DATA / 2026.10.03</small><h1>页面审核 · 16:9</h1><p>${intro}</p><p>点击截图放大，左右方向键切换，Esc 返回。可直接用编号反馈意见，例如“17 模型表单太宽”。</p><div class="bar"><label for="module">查看模块</label><select id="module"><option value="">全部 · ${shots.length} 张</option>${modules.map(module=>`<option>${esc(module)}</option>`).join('')}</select><span id="count">${shots.length} 张</span><a href="审核索引.md">文字索引</a></div></header><main><div class="grid">${cards}</div></main><footer>原图均为 PNG；截图中的账号、业务记录和任务状态来自隔离验收数据。${shots.length} 张原图覆盖 10 个主模块、登录页及常用子页。</footer><dialog id="viewer" aria-label="页面截图大图"><div class="viewerbar"><strong id="title"></strong><a id="original" target="_blank" rel="noopener">打开原图 ↗</a><button id="prev" aria-label="上一张">← 上一张</button><button id="next" aria-label="下一张">下一张 →</button><button id="close">关闭</button></div><img id="full" alt=""></dialog><script>
const shots=${JSON.stringify(shots).replaceAll('<','\\u003c')};const dialog=document.querySelector('#viewer'),full=document.querySelector('#full'),selector=document.querySelector('#module');let active=0,visible=shots;
function show(index){active=(index+visible.length)%visible.length;const item=visible[active];full.src=item.file;full.alt=item.title;document.querySelector('#title').textContent=item.id+' · '+item.title;document.querySelector('#original').href=item.file;if(!dialog.open)dialog.showModal();}
selector.addEventListener('change',()=>{visible=shots.filter(item=>!selector.value||item.module===selector.value);document.querySelectorAll('article').forEach(item=>item.hidden=!!selector.value&&item.dataset.module!==selector.value);document.querySelector('#count').textContent=visible.length+' 张';});
document.querySelectorAll('.shot').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();show(visible.findIndex(item=>item.id===link.dataset.id));}));document.querySelector('#prev').onclick=()=>show(active-1);document.querySelector('#next').onclick=()=>show(active+1);document.querySelector('#close').onclick=()=>dialog.close();dialog.addEventListener('keydown',event=>{if(event.key==='ArrowRight'){event.preventDefault();show(active+1);}if(event.key==='ArrowLeft'){event.preventDefault();show(active-1);}});
</script></html>`;
await writeFile(path.join(directory, '页面审核.html'), html);
const notes = [
  ['12', '多选控件样式', '展示配置中的“显示列”标签与删除按钮出现上下分行，视觉样式需要核对。截图保留当前表现。'],
  ['03—05', '分析工作台流式过程', '已按本次审核意见接通文字增量，工具和前后说明按发生顺序展示。完整录屏、最终结果和验收记录见 ../页面03-05流式验收/。'],
  ['07、11、17、19、29', '信息密度', '大屏表单、正文之间有较多留白；部分输入框横跨很宽的区域。可对照日常使用的屏幕判断字号、行距和表单宽度。'],
  ['23—27', '数据管理', 'DAS、数据源、白名单、连接参数、关系集中在长页面中，需要滚动切换操作区域。可重点审核是否需要进一步分区。'],
  ['28、30—35', '业务可读性', '多处显示负责人 ID、候选 ID 和运行 ID；后台任务状态主要以文字区分。可审核名称表达和状态辨识度。']
];
let md = `# 页面审核截图\n\n日期：2026-10-03。共 **${shots.length} 张原图**，覆盖 **10 个主模块**、登录页及常用子页。\n\n[打开图片浏览目录](页面审核.html) · [全模块缩略总览](全模块总览.png)\n\n${intro}\n\n截图主要使用亮色橄榄绿主题，画布补充暗色与属性面板。画布连线的动态流光在截图中只保留当前帧。账号为隔离管理员，用于展示完整导航；任务列表中的失败状态为展示数据。\n\n## 模块索引\n\n| 模块 | 图片编号 | 张数 |\n| --- | --- | ---: |\n`;
for(const module of modules){const items=shots.filter(item=>item.module===module);md+=`| ${module} | ${items.map(item=>`[${item.id}](${item.file})`).join('、')} | ${items.length} |\n`;}
md += '\n## 可优先审核的地方\n\n以下是观察点，尚未实施页面调整。\n\n| 编号 | 关注点 | 观察 |\n| --- | --- | --- |\n'+notes.map(row=>'| '+row.join(' | ')+' |').join('\n');
md += '\n\n## 逐图查看\n\n';
for(const item of shots)md+=`### ${item.id} · ${item.title}\n\n${item.module} · ${item.theme==='dark'?'暗色':'亮色'} · 1920×1080${item.note?' · '+item.note:''}\n\n![${item.id} ${item.title}](${item.file})\n\n`;
md += '## 采集记录\n\n- 采用已有 Chromium，视口 1920×1080，deviceScaleFactor 为 1。\n- 原图采用 viewport 截图，所有文件均核对 PNG 宽高为 16:9。\n- 登录、分析和报表使用现有隔离验收 HTTP 服务；管理、知识和任务页面使用现有合同校验的隔离响应数据。\n- 各主模块导航均已覆盖，截图过程中没有浏览器页面脚本异常。\n- 本次新增文件集中在此审核目录；沿用已安装依赖。产品页面和正式数据库未做修改。\n- 本次临时浏览器和服务在截图后关闭。\n\n采集脚本：`capture.mjs`；索引生成脚本：`build-gallery.mjs`；尺寸与页面记录：`screenshots.json`。\n';
await writeFile(path.join(directory, '审核索引.md'), md);

// 浏览器直接渲染图片目录生成总览，原图保持原始尺寸与内容。
const require = createRequire(path.resolve(directory, '../../ai-data/apps/web/package.json'));
const { chromium } = require('@playwright/test');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const featured = ['01','03','06','14','28','16','18','20','22','23','33','35'];
  const overview = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:28px 36px;background:#e9ece2;color:#242a1c;font-family:"Microsoft YaHei",sans-serif}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}h1{margin:0;font-size:29px}header p{font-size:16px;color:#626c51}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}article{background:white;overflow:hidden;border:1px solid #cdd3c2;border-radius:6px}img{width:100%;aspect-ratio:16/9;display:block}h2{margin:0;padding:8px 16px;font-size:16px}h2 span{color:#787e64;margin-right:10px}footer{font-size:15px;margin-top:20px;color:#626c51}</style><header><h1>AI Data · 全模块页面总览</h1><p>16:9 原图 ${shots.length} 张 / 2026.10.03</p></header><div class="grid">${featured.map(id=>shots.find(item=>item.id===id)).map(item=>`<article><img src="${esc(item.file)}"><h2><span>${item.id}</span>${esc(item.title)}</h2></article>`).join('')}</div><footer>10 个主模块 + 登录页 + 报表画布。点击「页面审核.html」按模块查看全部 1920×1080 原图。展示数据来自隔离验收环境。</footer></html>`;
  await writeFile(path.join(directory, '总览.html'), overview);
  await page.goto(pathToFileURL(path.join(directory, '总览.html')).href);
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({ path: path.join(directory, '全模块总览.png'), fullPage: false });
  await page.goto(pathToFileURL(path.join(directory, '页面审核.html')).href);
  const loaded = await page.locator('article img').evaluateAll(images => images.every(img => img.complete && img.naturalWidth===1920));
  // 全量加载是索引资源检查，不改变页面截图内容。
  await page.locator('article img').evaluateAll(images => images.forEach(img => img.loading='eager'));
  await page.waitForFunction(()=>[...document.querySelectorAll('article img')].every(img=>img.complete&&img.naturalWidth===1920));
  await page.locator('.shot').first().click();
  if(!await page.locator('#viewer').isVisible()) throw new Error('大图未打开');
  await page.keyboard.press('ArrowRight');
  if(!(await page.locator('#title').innerText()).startsWith('02')) throw new Error('切换失败');
  await page.keyboard.press('Escape');
  await page.locator('#module').selectOption('数据管理');
  const visible = await page.locator('article:visible').count();
  if(visible!==shots.filter(item=>item.module==='数据管理').length)throw new Error('筛选失败');
  await writeFile(path.join(directory, '目录检查.json'), JSON.stringify({ imageCount: shots.length, imageDimensions: '全部 1920×1080', loadedImages: true, viewer: true, keyboardNavigation: true, moduleFilter: true, initialLazyLoadComplete: loaded },null,2));
  console.log(`已生成 ${shots.length} 张截图目录，图片读取、大图切换和模块筛选通过。`);
} finally {await browser.close();}
