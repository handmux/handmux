import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateProjectDatabase } from '../src/projectTask/migrations.js';
import { restoreProjectBackup } from '../src/projectTask/backup.js';
import { DeviceAuthService } from '../src/deviceAuth/service.js';
import { tmpHome } from './tmphome.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
describe('authentication backup recovery', () => {
  it.each([false, true])('keeps the Token factor available after restoring a backup (auth schema: %s)', async (withAuth) => {
    const home = tmpHome(); const backup = path.join(home, 'backup.sqlite'); const target = path.join(home, 'restored.sqlite');
    const before = new DatabaseSync(backup);
    if (withAuth) {
      migrateProjectDatabase(before);
      const auth = new DeviceAuthService({ db: before, token: 'old-secret' });
      expect(auth.tokenEnabled).toBe(true); auth.close();
    }
    before.close();
    await restoreProjectBackup({ backupPath: backup, databasePath: target });
    const restored = new DatabaseSync(target);
    const auth = new DeviceAuthService({ db: restored, token: 'old-secret' });
    try {
      expect(auth.tokenEnabled).toBe(true);
      expect(auth.authenticateToken('old-secret', 'http://localhost')).not.toBeNull();
      expect(auth.createPairing(null, 'http://localhost', 'Browser').pairing.state).toBe('waiting');
    } finally { auth.close(); restored.close(); }
  });
});
