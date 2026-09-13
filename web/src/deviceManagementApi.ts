import { authenticationHeaders } from './authSession.js';
export interface ManagedDevice {
  id: string; name: string; browser_summary: string; authorized_at: number; expires_at: number | null;
  last_used_at: number; revoked_at: number | null; status: 'active' | 'expired' | 'revoked'; version: number;
}
export interface DeviceList {
  devices: ManagedDevice[]; currentDeviceId: string | null; tokenEnabled?: boolean;
  trustedDeviceEnabled?: boolean; trustedOriginEnabled?: boolean;
  publicUrl?: string | null; previewDomain?: string | null;
  trustedOrigins?: string[]; serverTime: number;
}
export interface DeviceApproval {
  id: string; state: 'configuring' | 'authorized' | 'expired' | 'canceled'; browserSummary: string;
  expiresAt: number; source: 'web'; origin?: string; device?: ManagedDevice;
}
export class DeviceManagementError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`/api/auth${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { ...authenticationHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw new DeviceManagementError(typeof value?.error === 'string' ? value.error : 'AUTH_UNAVAILABLE', response.status);
    return value as T;
  } finally { clearTimeout(timer); }
}
export const deviceManagementApi = {
  list: () => request<DeviceList>('/devices'),
  edit: (id: string, values: { version: number; name: string }) => request<{ device: ManagedDevice; serverTime: number }>(`/devices/${encodeURIComponent(id)}`, 'PATCH', values),
  revoke: (id: string) => request<{ device: ManagedDevice; serverTime: number }>(`/devices/${encodeURIComponent(id)}`, 'DELETE'),
  approvals: () => request<{ approvals: DeviceApproval[]; serverTime: number }>('/approvals'),
  claim: (code: string) => request<{ approval: DeviceApproval; serverTime: number }>('/approvals', 'POST', { code }),
  approval: (id: string) => request<{ approval: DeviceApproval; serverTime: number }>(`/approvals/${encodeURIComponent(id)}`),
  cancel: (id: string) => request<{ approval: DeviceApproval; serverTime: number }>(`/approvals/${encodeURIComponent(id)}`, 'DELETE'),
  authorize: (id: string, values: { name: string; expire: string }) => request<{ device: ManagedDevice; serverTime: number }>(`/approvals/${encodeURIComponent(id)}/authorize`, 'POST', values),
  addSelf: (name: string, expire: string) => request<{ device: ManagedDevice; serverTime: number }>('/devices/self', 'POST', { name, expire }),
  addTrustedOrigin: (origin: string) => request<{ trustedOrigins: string[]; serverTime: number }>('/trusted-origins', 'POST', { origin }),
  removeTrustedOrigin: (origin: string) => request<{ trustedOrigins: string[]; serverTime: number }>('/trusted-origins', 'DELETE', { origin }),
  inspectTrustedOriginRemoval: (origin: string) => request<{ affectedDevices: Array<{ id: string; name: string; browser_summary: string }> }>('/trusted-origins/inspect', 'POST', { origin }),
};
