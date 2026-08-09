// Runtime app-name injection. The web bundle ships prebuilt, so a user's custom name (set at
// `handmux start --name`) can't be baked at build time — instead the server rewrites the name into
// the shell HTML and the PWA manifest as it serves them. Pure string/object transforms so they're
// unit-testable; the server side-effects (read file / send) live in server.js.

const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Replace the browser-tab title and the iOS home-screen label in index.html. Matches by tag/attr,
// not by the default text, so it survives a changed default. No-op when a tag is absent.
export function applyAppName(html: string, name: string | null | undefined): string {
  if (!name) return html;
  const e = escAttr(name);
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${e}</title>`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${e}$2`);
}

// Override the PWA install name (Android uses short_name; both set so home-screen + app list agree).
export function applyManifestName<T extends object>(manifest: T, name: string | null | undefined) {
  if (!name) return manifest;
  return { ...manifest, name, short_name: name };
}
