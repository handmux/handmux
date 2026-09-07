import { useEffect, useState } from 'react';
import { copyText } from '../clipboard.js';
import { t } from '../i18n';
import { CheckIcon, CopyIcon } from './icons.jsx';

export default function CodexRecoveryCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [command]);

  const label = copied ? t('chat.status.copied') : t('chat.managedGuide.copyRecovery');
  return <div className="codex-managed-guide-command">
    <code>{command}</code>
    <button type="button" aria-label={label} title={label}
      onClick={() => { void copyText(command).then(setCopied); }}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  </div>;
}
