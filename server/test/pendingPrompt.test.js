import { describe, it, expect } from 'vitest';
import { parsePendingPrompt } from '../src/pendingPrompt.js';

// Real captures from a live Claude Code (2026-07-17).
const ASK_MENU = [
  '✻ Worked for 9s',
  '',
  ' ☐ 颜色',
  '',
  '你喜欢哪个?',
  '',
  '❯ 1. 红色',
  '     热情、醒目',
  '  2. 蓝色',
  '     沉稳、冷静',
  '  3. 绿色',
  '     自然、清新',
  '  4. Type something.',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '  manual mode on · 3 agents',
].join('\n');

const PERM_MENU = [
  'Bash command',
  '  rm -rf build/',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again this session",
  '  3. No, and tell Claude what to do differently (esc)',
  '',
  'Enter to select · Esc to cancel',
].join('\n');

// Multi-question: a tab strip, showing the CURRENT tab's question + options. ☒ = answered tab.
const MULTI_Q2 = [
  '✻ Cooked for 12s',
  '❯ some prompt echo',
  '────────────────────────────────',
  '←  ☒ 水果  ☐ 颜色  ✔ Submit  →',
  '选个颜色?',
  '❯ 1. 红',
  '  2. 蓝',
  '  3. Type something.',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

// The review/submit screen — has options but NO footer line.
const REVIEW = [
  '✻ Cooked for 12s',
  '────────────────────────────────',
  '←  ☒ 水果  ☒ 颜色  ✔ Submit  →',
  'Review your answers',
  ' ● 选水果?',
  '   → 苹果',
  ' ● 选颜色?',
  '   → 红',
  'Ready to submit your answers?',
  '❯ 1. Submit answers',
  '  2. Cancel',
].join('\n');

// The Write gate whose file the box above it previews. Captured verbatim from a live CodeBuddy pane
// (%5, 2026-09-22) — border, rows and trailing spaces included, because the parse turns on them.
const PREVIEW_BOX_GATE = [
  " │ | 9/13 | 监督失效 | 端到端一致性 45%、评审翻转 62–91%、RubyGems 被 Agent 打 |                  │",
  " │ | 9/14 | 降本与减速 | `PyroDash` 降 96%；问诊噪声下诊断准确率掉 15–25 点 |                     │",
  " │ | 9/15 | 入口与底座 | Siri 开放模型入口；**CI 脚手架才是 RCE 风险** |                          │",
  " │ | 9/16 | 模型能力升级 | Gemini 3.8 Live；`AGENTQ` 量化后门 100% |                              │",
  " │ | 9/17 | 工程落地 | 微软给 Bash 平反；ImpossibleBench：**同伴诱发越界** |                      │",
  " │ | 9/18 | Agent 接管研发 | Claude 主导 26% 研发；**失控会传染（0–5% → 40–95%）** |              │",
  " │ | 9/19 | 信任危机 | **ZCode 静默上传整个仓库** |                                               │",
  " │ | 9/20 | 范式之争 | Jev；Step 5；**Gemini 误打真公司** |                                       │",
  " │                                                                                                │",
  " │ ---                                                                                            │",
  " │                                                                                                │",
  " │ ## 待续                                                                                        │",
  " │                                                                                                │",
  " │ 2026-09-10 及更早未归档。查法：`https://hex2077.dev/docs/YYYY-MM/YYYY-MM-DD/` 按日期拼 URL；   │",
  " │ 当日热度看 `https://aihot.today/ai-news`。                                                     │",
  " │                                                                                                │",
  " ╰────────────────────────────────────────────────────────────────────────────────────────────────╯",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────",
  "",
  " Do you want to create ai-news-2026-09.md?",
  "",
  " > 1. Yes",
  "   2. Yes, and don't ask again this session (shift + tab)",
  "   3. No, and tell CodeBuddy what to do differently (escape)",
].join('\n');

describe('parsePendingPrompt', () => {
  it('returns null when there is no menu (no ❯ cursor option) on screen', () => {
    expect(parsePendingPrompt('just some\nterminal output\n$ ')).toBeNull();
    expect(parsePendingPrompt('')).toBeNull();
  });

  it('parses a single AskUserQuestion: real options + descriptions + cursor, meta dropped', () => {
    const g = parsePendingPrompt(ASK_MENU);
    expect(g.kind).toBe('question');
    expect(g.title).toBe('颜色 — 你喜欢哪个?');
    expect(g.options).toEqual([
      { n: 1, label: '红色', description: '热情、醒目' },
      { n: 2, label: '蓝色', description: '沉稳、冷静' },
      { n: 3, label: '绿色', description: '自然、清新' },
    ]);
    expect(g.cursor).toBe(1);
    expect(g.multi).toBeUndefined(); // single question → no tab metadata
  });

  it('parses a tool-permission menu as kind "permission"', () => {
    const g = parsePendingPrompt(PERM_MENU);
    expect(g.kind).toBe('permission');
    expect(g.title).toContain('Do you want to proceed?');
    expect(g.options.map((o) => o.label)[0]).toBe('Yes');
    expect(g.options).toHaveLength(3);
  });

  it('parses a multi-question tab screen: current question + step/total, title excludes the tab bar', () => {
    const g = parsePendingPrompt(MULTI_Q2);
    expect(g.title).toBe('选个颜色?'); // tab strip + rule + prompt echo all excluded
    expect(g.options).toEqual([
      { n: 1, label: '红', description: '' },
      { n: 2, label: '蓝', description: '' },
    ]); // "Type something." dropped
    expect(g.multi).toBe(true);
    expect(g.total).toBe(2);
    expect(g.step).toBe(2);     // 水果 answered (☒) → now on question 2
    expect(g.submit).toBe(false);
  });

  it('parses the review/submit screen (no footer) via the ❯ cursor anchor', () => {
    const g = parsePendingPrompt(REVIEW);
    expect(g.options).toEqual([
      { n: 1, label: 'Submit answers', description: '' },
      { n: 2, label: 'Cancel', description: '' },
    ]);
    expect(g.multi).toBe(true);
    expect(g.submit).toBe(true); // both tabs ☒ + option 1 is "Submit answers"
  });

  it('handles an options-only menu with no descriptions', () => {
    const g = parsePendingPrompt(['Pick one', '❯ 1. A', '  2. B', 'Esc to cancel'].join('\n'));
    expect(g.options).toEqual([
      { n: 1, label: 'A', description: '' },
      { n: 2, label: 'B', description: '' },
    ]);
    expect(g.title).toBe('Pick one');
  });

  // leadIn: the assistant text preceding the menu. The jsonl turn isn't flushed until AFTER the answer, so
  // this scrape is the 对话 lens's only way to show why a question is being asked. The title walk stops at
  // the first boundary (spinner/rule) — leadIn continues past it and keeps the text's last lines.
  it('leadIn — text above a spinner/rule boundary surfaces as the gate context (the reported bug)', () => {
    const g = parsePendingPrompt([
      '⏺ 探完了现有骨架,关键发现是后端零件基本齐全',
      '  所以推荐直接复用现有管线。',
      '',
      '✻ Worked for 9s',
      '────────────────────────────────',
      '你喜欢哪个方案?',
      '❯ 1. 方案A',
      '  2. 方案B',
      'Enter to select · Esc to cancel',
    ].join('\n'));
    expect(g.title).toBe('你喜欢哪个方案?'); // boundary keeps the title clean…
    expect(g.leadIn).toBe('探完了现有骨架,关键发现是后端零件基本齐全 所以推荐直接复用现有管线。'); // …but the text still shows
  });

  it('leadIn — adjacent text the title cannot absorb (⏺ is a boundary) surfaces as leadIn instead', () => {
    const g = parsePendingPrompt([
      '⏺ 验证标记 ABC123 这段是问题前的正文',
      '',
      '你喜欢哪个?',
      '❯ 1. 红色',
      '  2. 蓝色',
      'Enter to select · Esc to cancel',
    ].join('\n'));
    expect(g.title).toBe('你喜欢哪个?');                          // title stops at the ⏺ boundary…
    expect(g.leadIn).toBe('验证标记 ABC123 这段是问题前的正文');   // …and the text lands in leadIn
  });

  it('leadIn never crosses the user’s own ❯ prompt echo (that would be stale prior-exchange text)', () => {
    const g = parsePendingPrompt([
      '⏺ 上一轮的回答,与当前问题无关',
      '',
      '❯ 帮我选个颜色',
      '✻ Worked for 3s',
      '────────────────────────────────',
      '你喜欢哪个?',
      '❯ 1. 红色',
      '  2. 蓝色',
      'Enter to select · Esc to cancel',
    ].join('\n'));
    expect(g.leadIn).toBeUndefined(); // nothing between the prompt echo and the menu → no leadIn
  });

  it('leadIn — keeps only the LAST lines of a long preceding block', () => {
    const g = parsePendingPrompt([
      '⏺ 第一行结论',
      '  中间论证省略',
      '  最后一行才是重点',
      '✻ Cogitated for 4s',
      '────────────────────────────────',
      '选哪个?',
      '❯ 1. A',
      '  2. B',
      'Enter to select · Esc to cancel',
    ].join('\n'));
    expect(g.leadIn).toBe('中间论证省略 最后一行才是重点'); // capped at 2 lines, ⏺ stripped
  });

  it('no leadIn when nothing precedes the menu', () => {
    expect(parsePendingPrompt(ASK_MENU).leadIn).toBeUndefined();
    expect(parsePendingPrompt(PERM_MENU).leadIn).toBeUndefined(); // tool-call lines above a permission are not prose
  });

  // Real capture from a live CodeBuddy pane (%5, 2026-09-22): the Write gate asking to create the file the
  // box above it previews. The box's own rows and its bottom border are chrome — scraping them as context put
  // "│  │ ╰────…────╯" in front of the question on the phone.
  it('leadIn ignores a tool preview box: its border and its rows are not prose', () => {
    const g = parsePendingPrompt(PREVIEW_BOX_GATE);
    expect(g.title).toBe('Do you want to create ai-news-2026-09.md?');
    expect(g.leadIn).toBeUndefined();
    expect(g.options.map((option) => option.label)).toEqual([
      'Yes',
      "Yes, and don't ask again this session (shift + tab)",
      'No, and tell CodeBuddy what to do differently (escape)',
    ]);
  });

  it('leadIn still finds the prose above a preview box', () => {
    const g = parsePendingPrompt(['⏺ 日报已经按你的要求整理成三部分。', '', ...PREVIEW_BOX_GATE.split('\n')].join('\n'));
    expect(g.leadIn).toBe('日报已经按你的要求整理成三部分。');
  });
});
