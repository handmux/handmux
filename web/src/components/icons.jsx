// Monochrome line icons (Lucide, MIT) drawn with stroke=currentColor so they inherit the topbar's
// grey and sit flush with the ☰ glyph — no colour emoji clashing with the flat dark UI. Size comes
// from CSS (.topbar-icon svg); 1.75 stroke matches the hairline feel of the rest of the chrome.
import claudeLogo from '../assets/agent-claude.svg?raw';
import codexLogo from '../assets/agent-codex.svg?raw';

const base = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
};

export function FolderIcon() {
  return (
    <svg {...base}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}

// A folder with a small + — create a new directory in the file browser.
export function FolderPlusIcon() {
  return (
    <svg {...base}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg {...base}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// A document/page — for file entries in the browser (replaces the 📄 emoji).
export function FileIcon() {
  return (
    <svg {...base}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

// Image file — a framed picture with a sun + mountain (Lucide "image").
export function ImageIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

// ↑ go to the parent directory.
export function ArrowUpIcon() {
  return (
    <svg {...base}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

// ⊙ locate — jump the file browser to the active pane's current directory (session dir).
export function LocateIcon() {
  return (
    <svg {...base}>
      <line x1="2" x2="5" y1="12" y2="12" />
      <line x1="19" x2="22" y1="12" y2="12" />
      <line x1="12" x2="12" y1="2" y2="5" />
      <line x1="12" x2="12" y1="19" y2="22" />
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

// ▾ minimize the sheet (slide it back down).
export function ChevronDownIcon() {
  return (
    <svg {...base}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// ＋ add / open a new file → reveal the path browser.
export function PlusIcon() {
  return (
    <svg {...base}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// A check — confirm/save (the idea compose button in edit mode).
export function CheckIcon() {
  return (
    <svg {...base}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// 🏠 home — back to the recents view from the browser.
export function HomeIcon() {
  return (
    <svg {...base}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
    </svg>
  );
}

// A clock — stands for "最近" (recently opened).
export function ClockIcon() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

// A lightbulb — the per-window idea list, sits left of the inbox in the topbar. Same hairline line
// style as the rest of the topbar chrome (stroke=currentColor), so it reads as "ideas" without clashing.
export function BulbIcon() {
  return (
    <svg {...base}>
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
    </svg>
  );
}

// An inbox tray — the Claude-pane status roster (matches the topbar line-icon set, no emoji).
export function InboxIcon() {
  return (
    <svg {...base}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
    </svg>
  );
}

// ⬇ download a file (tray + down arrow).
export function DownloadIcon() {
  return (
    <svg {...base}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

// ⬆ upload a file — a document with an up arrow inside (Lucide file-up), clearer than a bare arrow
// that it means "send a file up".
export function UploadIcon() {
  return (
    <svg {...base}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M12 18v-6" />
      <path d="m9 15 3-3 3 3" />
    </svg>
  );
}

// ⧉ 复制(两片叠放的纸)——拷贝文件绝对路径到剪贴板。
export function CopyIcon() {
  return (
    <svg {...base}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

// ▶ 朗读/播放(描边三角,和线条图标一套,避免彩色 emoji)。
export function PlayIcon() {
  return (
    <svg {...base}>
      <path d="M7 5l12 7-12 7z" />
    </svg>
  );
}

// ⏸ 暂停(两条竖杠)。
export function PauseIcon() {
  return (
    <svg {...base}>
      <line x1="9" y1="5" x2="9" y2="19" />
      <line x1="15" y1="5" x2="15" y2="19" />
    </svg>
  );
}

// ⏹ 停止(圆角方块)。
export function StopIcon() {
  return (
    <svg {...base}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

// 🎙 麦克风(微信风:圆头话筒 + 弧形托 + 立杆)。描边图标,尺寸由 CSS 控制。
export function MicIcon() {
  return (
    <svg {...base}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  );
}

// 显示器 — 静态预览(和其余 topbar 图标同款描边)。
export function MonitorIcon() {
  return (
    <svg {...base}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

// 📊 用量/额度(Lucide gauge)——打开用量页(Claude/Codex 额度)。
export function GaugeIcon() {
  return (
    <svg {...base}>
      <path d="M12 14l4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}

// 📱 手机视图(Lucide smartphone)——预览切到移动端视口。
export function SmartphoneIcon() {
  return (
    <svg {...base}>
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <path d="M12 18h.01" />
    </svg>
  );
}

// ⟳ 刷新(两段环形箭头,Lucide refresh-cw)——重新加载预览页面。
export function RefreshIcon() {
  return (
    <svg {...base}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

// ⎇ git 分支(Lucide git-branch)——git 仓库查看器入口图标,同款描边。
export function GitIcon() {
  return (
    <svg {...base}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

// ✕ 关闭/删除(两条交叉线,Lucide x)。
export function XIcon() {
  return (
    <svg {...base}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

// ☆/★ 收藏星(Lucide star);填充由 CSS 控制(.cmd-star.on svg { fill: currentColor })。
export function StarIcon() {
  return (
    <svg {...base}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

// ⊡ 常用命令入口(Lucide square-terminal:圆角框 + > 提示符 + 横线)。
export function CommandIcon() {
  return (
    <svg {...base}>
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}

// ⧖ 续期(秒表 + 回拨箭头,Lucide timer-reset)——把有效期重置回 1 小时。
export function RenewIcon() {
  return (
    <svg {...base}>
      <path d="M10 2h4" />
      <path d="M12 14v-4" />
      <path d="M4 13a8 8 0 0 1 8-7 8 8 0 1 1-5.3 14L4 17.6" />
      <path d="M9 17H4v5" />
    </svg>
  );
}

// ⌨ Keyboard toggle with a direction chevron: an up chevron when the keyboard is down (tap to raise it)
// and a down chevron when it's up (tap to dismiss it).
export function KeyboardIcon({ down = false }) {
  return (
    <svg {...base}>
      <rect x="3" y="9" width="18" height="11" rx="2" />
      <path d="M7 13h.01M11 13h.01M15 13h.01M8 16.5h8" />
      {down ? <path d="M9 4.5l3 3 3-3" /> : <path d="M9 6.5l3-3 3 3" />}
    </svg>
  );
}

// 左右分屏(Lucide columns-2:圆角框 + 一条竖分隔)——把窗格分成左右两块。
export function SplitHIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

// 上下分屏(Lucide rows-2:圆角框 + 一条横分隔)——把窗格分成上下两块。
export function SplitVIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 12h18" />
    </svg>
  );
}

// 管理分屏(四宫格 layout)——跳到分屏地图,总览/管理当前窗口的所有窗格。
export function PaneMapIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M12 3v18M3 12h18" />
    </svg>
  );
}

// Agent logo — the OFFICIAL brand mark, kept as a swappable asset (src/assets/agent-<id>.svg; replace the
// file to change the logo). Imported as raw SVG source (?raw) and inlined as a REAL DOM <svg>, not an
// <img src="data:…svg…">: iOS standalone-PWA WKWebView doesn't reliably render percent-encoded svg+xml
// data-URIs in <img> (only these two logos vanished while every other icon — all inline <svg> — showed).
// Inlining still rides the content-hashed JS, so a changed logo busts the cache. Sized via CSS (.agent-mark).
const AGENT_LOGO = { claude: claudeLogo, codex: codexLogo };

// Pick the logo for an agent id (defaults to Claude for legacy/untagged entries).
export function AgentMark({ agent }) {
  const id = AGENT_LOGO[agent] ? agent : 'claude';
  return <span className="agent-mark" role="img" aria-label={id}
    dangerouslySetInnerHTML={{ __html: AGENT_LOGO[id] }} />;
}
