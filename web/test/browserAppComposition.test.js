import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const styles = readFileSync(path.resolve(process.cwd(), 'src/styles.css'), 'utf8');

describe('built-in browser App composition', () => {
  it('routes each pane through one keyed Surface bundle with distinct view and controls identities', () => {
    expect(source).toContain("import PaneSurfaceHost from './components/PaneSurfaceHost.jsx'");
    expect(source).toContain('const paneSurfaceOwnerKey =');
    expect(source).toContain('<PaneSurfaceHost');
    expect(source).toContain('primary={current.paneId && (');
    expect(source).toContain('controls={chatLens ? (');
    expect(source).toContain('key={`conversation-view\\0');
    expect(source).toContain('key={`conversation-controls\\0');
  });

  it('keeps the selected chat lens mounted through transient capability failures', () => {
    expect(source).toContain("const chatLens = lens === 'chat' && conversationEnabled;");
    expect(source).not.toMatch(/const chatLens\s*=\s*chatLensAvailable\s*&&/);
    expect(source).toContain('currentAgentDescriptor?.capabilities.conversation === true');
    expect(source).toContain('normalizedConversationIdentity');
    expect(source).not.toMatch(/chatAgent\s*===\s*['"](?:codex|claude|pi)['"]/);
    expect(source).toContain('chatLensEnabled={chatLensAvailable || chatLens}');
    expect(source).toContain('currentAgentDescriptor.capabilities.conversationActivation === true');
    expect(source).toContain('<AgentConversationActivationGuide controller={conversationActivation}');
    expect(source).not.toContain('/api/codex/takeover');
    expect(source).not.toContain('codexChatReady');
    expect(source).not.toContain('codexChatLoading');
    expect(source).not.toContain('onInteractiveSlash');
    expect(source).toContain('lensSelection.paneId === currentPaneId');
    expect(source).not.toContain('useLayoutEffect');
  });

  it('uses Catalog-driven Conversation preferences and never provider-specific Settings props', () => {
    expect(source).toContain('.filter((descriptor) => descriptor.capabilities.conversation)');
    expect(source).toContain('experimental: descriptor.capabilityMetadata?.conversation?.experimental === true');
    expect(source).toContain('conversationAgents={conversationAgents}');
    expect(source).toContain('onConversationAgentEnabled={toggleAgentConversation}');
    expect(source).not.toMatch(/claudeChatLensEnabled|codexChatLensEnabled/);
    expect(source).toContain("if (!enabled && agentId === chatAgent && current?.paneId)");
  });

  it('treats a current raw run as authoritative over a remembered managed identity', () => {
    expect(source).toMatch(/const currentConversationIdentity = currentAgentRun[\s\S]*?currentAgentRun\.sessionId[\s\S]*?: null/);
    expect(source).toContain('waiting={currentKind === \'permission\'}');
  });

  it('creates a one-shot completed-answer entry only after a done inbox row opens successfully', () => {
    expect(source).toContain("if (opened && row.view === 'done')");
    expect(source).toMatch(/setCompletedChatEntry\(\{\s*paneId: row\.pane,\s*session: row\.session,\s*window: row\.window,/);
    expect(source).toContain('completedEntryRequest={completedEntryRequest}');
    expect(source).toContain('onCompletedEntryConsumed={consumeCompletedChatEntry}');
  });

  it('mounts one global browser model and its sheet', () => {
    expect(source).toContain("import BrowserSheet from './components/BrowserSheet.jsx'");
    expect(source).toContain("import { useBrowser } from './hooks/useBrowser.js'");
    expect(source).toMatch(/const browser = useBrowser\(\{ enabled: !needToken, browserProxy: !!serverConfig\?\.browserProxy \}\)/);
    expect(source).toContain('<BrowserSheet browser={browser} staticPreview={staticPreview} />');
    expect(source).toContain('historyActive: browser.historyActive && !staticPreview.selected');
    expect(source).toMatch(/switchTab: \(\) => \{\s*staticPreview\.deactivate\(\);\s*browser\.switchTab\('history'\)/);
  });

  it('renders the browser toolbar entry unconditionally', () => {
    const browserEntryIndex = source.indexOf('className={`topbar-icon browser-entry');
    expect(browserEntryIndex).toBeGreaterThan(-1);
    expect(source.slice(browserEntryIndex, browserEntryIndex + 240))
      .toContain('onClick={() => browser.setOpen(true)}');
    expect(source).not.toMatch(/\{shownPreview && \(\s*<button className="topbar-icon preview-live"/);
    expect(browserEntryIndex).toBeLessThan(source.indexOf('aria-label={t(\'app.files\')}'));
    expect(source.slice(
      browserEntryIndex,
      source.indexOf('aria-label={t(\'app.files\')}'),
    )).not.toContain('aria-label={t(\'usage.title\')}');
  });

  it('shows device-tab status on the browser entry with proxy precedence', () => {
    expect(source).toMatch(/const browserStatus = browserEntryStatus\(\[\s*\.\.\.browser\.tabs,[\s\S]*mode: 'static'/);
    expect(source).toContain("className={`topbar-icon browser-entry${browserStatus ? ` ${browserStatus}` : ''}`}");
    expect(source).not.toContain('browser-entry-status-dot');
    expect(styles).not.toContain('.browser-entry-status-dot');
    expect(styles).toMatch(/\.browser-entry\.direct\s*>\s*svg\s*\{[^}]*color:\s*var\(--blue\)/);
    expect(styles).toMatch(/\.browser-entry\.proxy\s*>\s*svg\s*\{[^}]*color:\s*#d9b44a/);
    expect(styles).toMatch(/\.browser-entry\.static\s*>\s*svg\s*\{[^}]*color:\s*var\(--green\)/);
  });

  it('routes confirmed terminal web links into the built-in browser', () => {
    expect(source).toContain('await browser.openUrl(p.raw, { mode, signal: controller.signal })');
    expect(source).toContain('modeChoices={true}');
    expect(source).toContain('proxyAvailable={browser.proxyAvailable}');
    expect(source).toContain('const [localUrlBusyMode, setLocalUrlBusyMode] = useState');
    expect(source).toContain('busyMode={localUrlBusyMode}');
    expect(source).not.toContain('if (!p || localUrlOpeningRef.current) return');
    expect(source).toMatch(/const p = localUrlPrompt;[\s\S]*?localUrlAbortRef\.current\?\.abort\(\);[\s\S]*?const controller = new AbortController\(\)/);
    expect(source).toContain('allowRepeat={true}');
    expect(source).not.toContain('startUrlPreview({');
    expect(source).not.toContain('disabled={!dynamicEnabled}');
  });

  it('keeps the loading progress visual while page interaction remains available', () => {
    const rule = styles.match(/\.browser-page-loading\s*\{([^}]+)\}/)?.[1] || '';
    expect(rule).toContain('pointer-events: none');
    expect(rule).not.toContain('touch-action: none');
  });
});
