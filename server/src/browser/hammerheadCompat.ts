import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PATCHED = Symbol.for('handmux.hammerhead.websocket-upgrade-socket');
const RESPONDER_PATCHED = Symbol.for('handmux.hammerhead.websocket-mock-response');
const REQUEST_INFO_PATCHED = Symbol.for('handmux.hammerhead.request-info-frame-nature');

type MarkedFunction = ((...args: unknown[]) => unknown) & Record<symbol, unknown>;
type UnknownRecord = Record<string | symbol, unknown>;
const recordOf = (value: unknown): UnknownRecord | null => (
  value && (typeof value === 'object' || typeof value === 'function') ? value as UnknownRecord : null
);

export function patchHammerheadDestinationRequest(input: unknown): boolean {
  const prototype = recordOf(recordOf(input)?.prototype);
  const original = prototype?._onUpgrade;
  if (typeof original !== 'function' || original.length !== 3) {
    throw new Error('unsupported Hammerhead DestinationRequest._onUpgrade signature');
  }
  if (!prototype) throw new Error('unsupported Hammerhead DestinationRequest prototype');
  const upgrade = original as MarkedFunction;
  if (upgrade[PATCHED]) return false;

  function onUpgrade(this: unknown, response: unknown, socket: unknown, head: unknown): unknown {
    const responseRecord = recordOf(response);
    if (responseRecord) responseRecord.socket ??= socket;
    return upgrade.call(this, response, socket, head);
  }
  Object.defineProperty(onUpgrade, PATCHED, { value: true });
  prototype._onUpgrade = onUpgrade;
  return true;
}

export function patchHammerheadWebSocketResponder(websocketInput: unknown, headerTransformsInput: unknown): boolean {
  const websocket = recordOf(websocketInput);
  const headerTransforms = recordOf(headerTransformsInput);
  const original = websocket?.respondOnWebSocket;
  if (typeof original !== 'function') {
    throw new Error('unsupported Hammerhead WebSocket responder');
  }
  if (!websocket) throw new Error('unsupported Hammerhead WebSocket module');
  const respond = original as MarkedFunction;
  if (respond[RESPONDER_PATCHED]) return false;

  function respondOnWebSocket(ctx: unknown): unknown {
    const context = recordOf(ctx);
    const response = recordOf(context?.res);
    const destination = recordOf(context?.destRes);
    if (destination?.socket) return respond(ctx);
    if (!destination || typeof response?.end !== 'function') return respond(ctx);

    if (typeof headerTransforms?.forResponse !== 'function') throw new Error('unsupported Hammerhead header transforms');
    const headers = recordOf(headerTransforms.forResponse(ctx)) ?? {};
    const missingUpgradeSocket = destination.statusCode === 101;
    const statusCode = missingUpgradeSocket ? 502 : destination.statusCode || 502;
    const statusMessage = missingUpgradeSocket ? 'Bad Gateway' : destination.statusMessage || 'Bad Gateway';
    const lines = [`HTTP/${destination.httpVersion || '1.1'} ${statusCode} ${statusMessage}`];
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) value.forEach((item) => lines.push(`${name}: ${item}`));
      else if (value != null) lines.push(`${name}: ${value}`);
    }
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'connection')) {
      lines.push('connection: close');
    }
    response.end(`${lines.join('\r\n')}\r\n\r\n`);
    return undefined;
  }
  Object.defineProperty(respondOnWebSocket, RESPONDER_PATCHED, { value: true });
  websocket.respondOnWebSocket = respondOnWebSocket;
  return true;
}

export function patchHammerheadRequestInfo(input: unknown): boolean {
  const RequestInfo = recordOf(input);
  const original = RequestInfo?.from;
  if (typeof original !== 'function') {
    throw new Error('unsupported Hammerhead RequestInfo.from');
  }
  if (!RequestInfo) throw new Error('unsupported Hammerhead RequestInfo');
  const createInfo = original as MarkedFunction;
  if (createInfo[REQUEST_INFO_PATCHED]) return false;

  function from(this: unknown, ctx: unknown): unknown {
    const info = createInfo.call(this, ctx);
    const infoRecord = recordOf(info);
    if (!infoRecord) throw new Error('invalid Hammerhead RequestInfo result');
    infoRecord.isIframe = Boolean(recordOf(ctx)?.isIframe);
    return info;
  }
  Object.defineProperty(from, REQUEST_INFO_PATCHED, { value: true });
  RequestInfo.from = from;
  return true;
}

export function installHammerheadWebSocketUpgradeCompat(): boolean {
  const DestinationRequest = require('testcafe-hammerhead/lib/request-pipeline/destination-request') as unknown;
  const websocket = require('testcafe-hammerhead/lib/request-pipeline/websocket') as unknown;
  const headerTransforms = require('testcafe-hammerhead/lib/request-pipeline/header-transforms') as unknown;
  const infoModule = require(
    'testcafe-hammerhead/lib/request-pipeline/request-hooks/events/info',
  ) as unknown;
  const RequestInfo = recordOf(infoModule)?.RequestInfo;
  const destinationPatched = patchHammerheadDestinationRequest(DestinationRequest);
  const responderPatched = patchHammerheadWebSocketResponder(websocket, headerTransforms);
  const requestInfoPatched = patchHammerheadRequestInfo(RequestInfo);
  return destinationPatched || responderPatched || requestInfoPatched;
}
