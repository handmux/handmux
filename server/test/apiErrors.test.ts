import express from 'express';
import request from 'supertest';
import type { Test } from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { PublicApiError, apiErrorBoundary, apiRequestContext } from '../src/apiErrors.js';
import { createApiRouter } from '../src/httpApi.js';
import * as defaultCommands from '../src/tmux/commands.js';

const auth = (value: Test) => value.set('Authorization', 'Bearer good');
// httpApi remains a legacy JS composition root during M1; narrow its inferred signature at the test seam
// until that module migrates and owns a concrete dependency interface.
const createRouter = createApiRouter as unknown as (
  options: Record<string, unknown>,
) => express.Router;

describe('API error contract', () => {
  it('turns an unexpected route failure into stable JSON without leaking its stack or path', async () => {
    const log = { error: vi.fn() };
    const commands = {
      ...defaultCommands,
      listSessions: vi.fn(async () => {
        throw new Error('database failed at /Users/private/secrets.json');
      }),
    };
    const app = express();
    app.use('/api', createRouter({
      token: 'good',
      commands,
      apiErrors: { idFactory: () => 'request-fixed', log },
    }));

    const response = await auth(request(app).get('/api/sessions')).expect(500);
    expect(response.type).toBe('application/json');
    expect(response.headers['x-request-id']).toBe('request-fixed');
    expect(response.body).toEqual({
      error: 'internal server error', code: 'internal_error', requestId: 'request-fixed',
    });
    expect(response.text).not.toContain('/Users/private');
    expect(response.text).not.toContain('apiErrors.test');
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0][1]).toMatchObject({
      requestId: 'request-fixed', method: 'GET', path: '/api/sessions',
    });
  });

  it('maps malformed JSON and unknown API routes without invoking the internal-error logger', async () => {
    const log = { error: vi.fn() };
    const options = { idFactory: () => 'request-fixed', log };
    const app = express();
    app.use('/api', createRouter({ token: 'good', commands: defaultCommands, apiErrors: options }));

    const malformed = await auth(request(app).post('/api/sessions'))
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    expect(malformed.body).toEqual({
      error: 'invalid json', code: 'invalid_json', requestId: 'request-fixed',
    });

    const missing = await auth(request(app).get('/api/does-not-exist')).expect(404);
    expect(missing.body).toEqual({
      error: 'not found', code: 'not_found', requestId: 'request-fixed',
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('allows an explicitly public error while retaining the common envelope', async () => {
    const app = express();
    const options = { idFactory: () => 'request-fixed' };
    app.use(apiRequestContext(options));
    app.get('/conflict', (_req, _res, next) => {
      next(new PublicApiError(409, 'queue_full', 'queue is full'));
    });
    app.use(apiErrorBoundary(options));

    const response = await request(app).get('/conflict').expect(409);
    expect(response.body).toEqual({
      error: 'queue is full', code: 'queue_full', requestId: 'request-fixed',
    });
  });
});
