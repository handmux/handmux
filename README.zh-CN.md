<h1 align="center">handmux</h1>

<p align="center"><a href="README.md">English</a> · <b>中文</b></p>

<p align="center"><a href="https://handmux.com"><b>handmux.com</b></a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/handmux"><img src="https://img.shields.io/npm/v/handmux?color=cb3837&logo=npm" alt="npm"></a>
  <a href="https://github.com/handmux/handmux/actions/workflows/test.yml"><img src="https://github.com/handmux/handmux/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license: AGPL-3.0"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white" alt="node"></a>
</p>

> **一部手机,一整套移动 Vibe Coding 驾驶舱。** 基于 tmux——电脑上一行命令、手机扫码,你正跑着的会话、Claude Code、Codex、git、预览、文档全到手里,创造力随时随地都在你手上。

handmux 不只是把终端搬上手机。它把你电脑上**正跑着的 tmux 会话**原样搬进手机浏览器(同一个真实 pane,不是只读镜像),再围着它搭起一整套**移动 Vibe Coding 驾驶舱**:**Claude Code / Codex** 要你拍板时推到手机、拇指一点就批,动动嘴就发新指令;**git** 全屏看彩色 diff;一键**预览**正跑着的网站;**文档**逐句朗读;文件随手双向传。手机端**零安装**——点开链接就进去,"添加到主屏"即成全屏 **PWA**,和原生 App 基本无异。窝在沙发、挤在地铁,Vibe Coding 不停,创造力随时在你手里。

<p align="center">
  <img src="assets/handmux-run.gif" alt="handmux:说出需求,Claude Code 写好,点文件名即可预览结果" width="280">
  &nbsp;&nbsp;
  <img src="assets/handmux-doc.gif" alt="handmux:需要你时推送提醒,查看 git 仓库和每个 agent 的用量" width="280">
  <br>
  <em>真实手机浏览器、真实 pane——左:说出需求,Claude Code 直接写好,点文件名即可预览;右:需要你时推送提醒,查看 git 仓库与各 agent 用量。</em>
</p>

**[📖 文档](https://handmux.com/docs)** · **[📝 更新日志](CHANGELOG.md)** · **[📦 npm](https://www.npmjs.com/package/handmux)**

## 快速上手 · 约一分钟

**电脑上**需要 Node ≥ 18 和 tmux ≥ 3.0(手机只要个浏览器)。然后:

```bash
npm i -g handmux     # 装一次
handmux start        # 跑起来 —— 仅本机 / 同 wifi,不对外暴露
```

`start` 会打印一个**二维码**(外加地址和 token)。**手机扫它**——token 在码里,首次打开即登录。你会看到自己真实的 tmux 会话,点一个就开始操作。

想从**任何地方**都连得上?加一个参数开一条免费公网 HTTPS 链接:

```bash
handmux start --tunnel cloudflare   # 即时公网地址(自动装 cloudflared)
```

> 隧道类型、自建、Windows/WSL2、完整命令与参数 → 见 **[文档](https://handmux.com/docs)**。

## 为什么是 handmux

- **🧰 不只是终端——一整套装进口袋的移动 Vibe Coding 驾驶舱。** git 全屏看彩色 diff、一键预览正跑着的网站、文档逐句朗读、文件随手双向传——一整套开发能力,此刻全套在手,不用在几个 App 间来回切。
- **🚀 一分钟从零到手机上敲代码。** 一条 `handmux start`、扫个码,完事——不注册、不上应用商店、不装 App,一个链接就进去。"添加到主屏"后即为全屏 **PWA**,和原生 App 一样顺手。
- **🧶 人走,活不停。** 手机连的是你工位上**那一个**正跑着的 tmux pane(不是新 shell、不是截图)。合上电脑,拇指接着盯,状态一点不差。
- **🔔 需要你时,手机会响。** Claude Code / Codex 一到要你拍板就推送;添加到主屏后直接走系统通知。收件箱标「进行中 / 需要你 / 已完成」,多项目并行状态一览无余,拇指一点批授权批计划,别再守着屏幕等它。
- **🔒 你的代码,不经过任何中转。** 免费、完全开源;我们没有中转服务器,数据只在你的电脑和手机之间直接走,确保安全。

## 功能一览

- **Claude Code / Codex 深度**——收件箱状态台账、拇指批授权批计划、各 agent 用量条。
- **命令 / 聊天双模式**——底部一栏两种模式:直接敲进终端,或用自然语言发给 agent。预置 ESC/Tab/Ctrl+C、自定义 ⌃⇧⌥ 组合键,常用 / 最近命令分全局或按窗口(含斜杠命令)。
- **Git 查看器**——改动 / 提交历史 / 任意分支 / 全屏彩色 diff,多仓库分页,只读不动工作区。
- **站点预览**——挑目录预览静态站,或按端口预览正跑的服务(路由 / 接口 / HMR 全保留)。
- **文档**——终端里点路径即开;Markdown 排版、字号缩放、逐句高亮朗读。
- **文件双向传**——聊天框多选上传、下载、系统分享进来、复制绝对路径。
- **想法 · 随想随记**——不错过任何点子:每窗口一份想法清单,灵感一冒就记(能语音速记),一点填进输入框。
- **专治弱网**——退避重连、掉线横幅、离线兜底页、后台暂停轮询;光标不乱跳、拖动选中复制。
- **零安装 PWA**——浏览器直接跑,可加主屏全屏运行;多语言(English、简体 / 繁體中文、日本語、한국어)。

## 联网:一句话决策

默认不开隧道——手机**直连你自己的电脑**,什么都不暴露、也没有中间人。想从外面连,只问一句:**电脑有没有公网地址?**

- **有**(云主机 / 公网 IP / 已端口转发)—— 不用隧道,直接连,最快也最私密。
- **没有** —— 开一条隧道。每条都跑在**你自己的免费第三方账号**上,handmux 只负责接通、自身不设中转:`cloudflare`(零配置秒通,但公共边缘在国内常不稳)· `cloudflare-named`(你的域名,更稳)· `natapp` / `cpolar`(国内厂商,大陆境内可达)· `ssh` 自建(接你自己的服务器)。

> 隧道配置、服务端反向代理、开机自启、语音 / 推送凭证、端口预览等细节 → 见 **[文档](https://handmux.com/docs)**。

## 环境要求

电脑需 **Node ≥ 18** 与 **tmux ≥ 3.0**;手机只要浏览器。**Windows** 请装进 **WSL2**(真 Linux 内核 + 真 tmux)——见 [文档](https://handmux.com/docs#windows)。

## 反馈与交流

遇到 bug、或者希望 handmux 多干点什么?[**发个 Issue**](https://github.com/handmux/handmux/issues)——这是真正会被跟踪处理的渠道(中英文都行)。也欢迎加入**用户微信群**,反馈直达、用法交流:

<img src="https://handmux.com/wechat-qr.png" alt="微信用户群:扫码加作者微信,备注 handmux" width="180">

## 更多

**[📖 文档](https://handmux.com/docs)** · **[📝 更新日志](CHANGELOG.md)** · **[🔒 安全](SECURITY.md)** · 许可证 **AGPL-3.0**

发现安全问题请私下报告(见 [SECURITY.md](SECURITY.md)),别开公开 issue。
