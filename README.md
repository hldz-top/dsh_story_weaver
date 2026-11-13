---
description: "基于 DSH 的独立长篇小说创作、去 AI 味评审与持久化写作插件。"
kind: "package-bundle"
---
# DSH Story Weaver

`dsh-story-weaver` 是一款运行在 DSH 宿主环境中的独立长篇小说创作插件，覆盖从题材调研、多维设定、全书大纲、章节细纲到章节正文创作与审校的完整流程。

## 核心功能

- **多维设定与题材调研**：围绕题材类型、受众、风格基调、时空背景、主角人设、金手指与核心主线等维度自动开展背景调研，生成结构化的小说设定集，并支持导入作者自定义设定。
- **全书大纲与章节细纲**：基于生效的设定集自动规划全书故事脉络与分章细纲，明确每章核心事件与节奏。
- **正文创作与连贯性校验**：按章节细纲生成小说正文（默认单章 3,000–5,000 字），每一章均经过正文质量评审与前后剧情连贯性校验，自动修复字数偏差、设定矛盾或剧情断层。
- **去 AI 味写作与审校**：深度集成开源去 AI 味项目 [lieflat-less-ai-tone](https://github.com/larashero3-dotcom/lieflat-less-ai-tone)（MIT License）。写作提示仍提醒避免翻案腔、套话和名词化总结；评审按密度给出 hint / notice / heavy 分级提示。文笔和 AI 味不会因此打回整章或阻止应用。对话不参与检测。硬性阻断仍只针对义务缺失、设定或人设矛盾、跨章连续性冲突，以及宿主对整章字数的验收。
- **局部修订与断点续跑**：支持单独修订某一项设定、全书大纲或章节细纲，并按需更新受影响的下游内容；所有阶段产物与运行状态均持久化保存在本地存储中，支持随时中断与恢复运行。
- **版本化预览**：支持将设定、大纲、正文及评审记录一键导出为带版本的 Markdown 文件，在会话中直接预览。

## 安装与卸载

在满足 Node ≥ 22.19、DSH 0.2.2-rc.2 及 pnpm（推荐 `11.7.0`）的环境中，通过 DSH CLI 安装：

```sh
dsh plugin --profile web add dsh-story-weaver
```

也可以在 DSH Web 界面的 **Plugins → Add plugin** 中输入 `dsh-story-weaver` 进行安装。

卸载插件：

```sh
dsh plugin --profile web remove dsh-story-weaver
```

## 常用工具

| 工具名称 | 功能说明 |
| --- | --- |
| `story_write` | 规划并执行设定调研、大纲生成与章节正文写作全流程 |
| `story_revise` | 单独修订指定的设定维度、全书大纲或章节大纲 |
| `story_update` | 根据上游设定或大纲的变更，重建受影响的下游章节内容 |
| `story_resume` / `story_stop` | 恢复未完成的写作任务，或安全停止当前运行 |
| `story_get_settings` / `story_get_manuscript` | 查看当前生效的设定集、手稿状态及待更新项 |
| `story_read_artifact` / `story_preview` | 分页读取产物全文，或生成可预览的 Markdown 文档 |
| `story_settings_import` | 导入作者手写的设定维度内容（需在配置中开启） |

## 本地开发

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## 致谢与开源许可

本项目的去 AI 味检测规则与写作约束改编自 [lieflat-less-ai-tone](https://github.com/larashero3-dotcom/lieflat-less-ai-tone)（Copyright (c) 2026 shiujan，基于 [MIT 许可证](third_party/lieflat-less-ai-tone.LICENSE) 授权）。
