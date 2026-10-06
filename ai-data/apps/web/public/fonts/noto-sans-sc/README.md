# Noto Sans SC 导出字体

本目录用于第 7 步 PDF 中文导出的同源静态资源。字体固定为 Noto CJK `Sans2.004` 发布中的 Noto Sans SC，采用 OFL-1.1 许可。

## 来源与文件

- [官方仓库及固定版本](https://github.com/notofonts/noto-cjk/tree/Sans2.004)
- [NotoSansSC-Regular.otf](https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf)：常规字重，8,331,336 字节。
- [NotoSansSC-Bold.otf](https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-Bold.otf)：粗体字重，8,543,168 字节。
- [LICENSE](https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE)：原始 OFL-1.1 许可证，4,301 字节；随字体保留和分发。

上述三份文件由项目维护者按第 7 步交付说明下载到本目录。版本、大小和 SHA-256 的机器可读核对清单位于项目外层 `任务交接/前端第7步依赖核对.json`。

## 加载与部署约定

字体文件合计约 16.1 MiB，作为 Web 静态资源随构建部署。PDF 导出将在需要时从 `/fonts/noto-sans-sc/` 读取并嵌入常规／粗体字体；项目部署在子路径时，加载地址按 Web 的基础路径解析。

下载时按核对清单校验完整性，保留原始文件名、版权声明及许可证。PDF 字体映射、Worker 兼容性和中文缺字检查将在资源安装后的兼容性验收中完成。

## 2026-09-28 本机资源核对更新

用户确认优先复用本机字体后，当前目录已保存 `NotoSansSC-VF.ttf`（17,773,244 字节），来源为 `C:/Windows/Fonts/NotoSansSC-VF.ttf`；SHA-256 为 `763146584cf0710223441356b4395e279021b0806c196614377a7a0174ae074a`。系统原字体保留。内嵌版本为 `Version 2.04;241114210130;non-release`，许可字段明确为 OFL-1.1。

同目录 LICENSE 取自 [Noto Sans SC 官方许可](https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt)，保留 Adobe 版权及保留字体名说明。此资源与上文原计划的两份静态 OTF 分开核对。

该可变字体在当前 pdfmake 浏览器 Worker 的 Regular／Bold 实例加载中出现兼容错误，尚未通过中文 PDF 验收。实际问题、静态字体调整及待确认状态记录于外层 `任务交接/前端第7步字体兼容调整清单.md`。

## 2026-09-28 静态字体最终验证

用户授权按原方案下载后，当前采用本页最初列出的 Sans2.004 常规／粗体 OTF 和该发布的原始 LICENSE。三份文件的大小及 SHA-256 已核对，中文 PDF 在 Chromium Worker 中生成成功，常规／粗体资源区分、文字提取和两页渲染目视检查通过。

测试用可变字体项目副本已移除；系统原字体保留。构建和部署应同时保留 `NotoSansSC-Regular.otf`、`NotoSansSC-Bold.otf`、`LICENSE`。后续继续从同源路径按需加载两种字重。
