import { LocalConnectorBridgeClient } from '../bridgeClient.js';
import type { LocalConnectorBridgeClientOptions } from '../bridgeClient.js';

export type PiBridgeClientOptions = Omit<LocalConnectorBridgeClientOptions, 'adapterId'>;

// Compatibility name for the Pi Extension. Connection, retry, durable queue and request behavior are
// implemented once by the shared Handmux-owned Connector client.
export class PiBridgeClient extends LocalConnectorBridgeClient {
  constructor(options: PiBridgeClientOptions) {
    super({ ...options, adapterId: 'pi' });
  }
}
