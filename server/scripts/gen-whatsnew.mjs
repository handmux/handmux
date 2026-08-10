// Mirror the changelog's concise per-version highlights into server/package.json `whatsNew`, so an OLDER
// install can learn "what's new" in a release it doesn't have yet — fetched through the user's own npm
// (`npm view handmux@latest whatsNew`), which stays China-mirror-friendly. Source of truth is
// web/src/changelog.ts; run by release.sh before the release commit (and manually to refresh in-repo).
//
// package.json is edited as TEXT, not re-serialized: a JSON.stringify round-trip would reflow the inline
// `keywords`/`files` arrays. We keep `whatsNew` as the LAST key, one compact line per entry, for clean diffs.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..', 'package.json');
const CHANGELOG = path.join(HERE, '..', '..', 'web', 'src', 'changelog.ts');
const KEEP = 8; // how many recent public versions to publish (a user many versions behind still sees them all)

const require = createRequire(import.meta.url);
const ts = require('typescript');

export async function readChangelog(changelogPath = CHANGELOG) {
  const source = fs.readFileSync(changelogPath, 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: changelogPath,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length) {
    throw new Error(ts.formatDiagnostics(errors, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    }));
  }

  const sourceUrl = `${pathToFileURL(changelogPath).href}?generated-for-whats-new`;
  const encoded = Buffer.from(`${result.outputText}\n//# sourceURL=${sourceUrl}\n`).toString('base64');
  const loaded = await import(`data:text/javascript;base64,${encoded}`);
  if (!Array.isArray(loaded.CHANGELOG)) throw new Error('changelog.ts must export a CHANGELOG array');
  return loaded.CHANGELOG;
}

export function projectWhatsNew(entries, keep = KEEP) {
  return entries
    .filter((entry) => entry?.version && entry?.highlight)
    .slice(0, keep)
    .map((entry) => ({
      version: entry.version,
      date: entry.date,
      zh: entry.highlight.zh,
      en: entry.highlight.en,
    }));
}

export async function generateWhatsNew({ packagePath = PKG, changelogPath = CHANGELOG } = {}) {
  const entries = await readChangelog(changelogPath);
  const whatsNew = projectWhatsNew(entries);

  let text = fs.readFileSync(packagePath, 'utf8');
  text = text.replace(/,\n\s*"whatsNew":\s*\[[\s\S]*?\n\s*\]/, ''); // drop a prior block (always the last key)
  const block = '  "whatsNew": [\n'
    + whatsNew.map((entry) => '    ' + JSON.stringify(entry)).join(',\n')
    + '\n  ]';
  const updated = text.replace(/\n\}\s*$/, ',\n' + block + '\n}\n');
  if (updated === text) throw new Error(`could not append whatsNew to ${packagePath}`);
  text = updated;

  JSON.parse(text); // guard: never write invalid JSON
  fs.writeFileSync(packagePath, text);
  console.log(`whatsNew: wrote ${whatsNew.length} version(s) → ${path.relative(process.cwd(), packagePath)}`);
  return whatsNew;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateWhatsNew();
}
