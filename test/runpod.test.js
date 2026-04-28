'use strict';

const https = require('https');
const fs = require('fs');
const { Readable } = require('stream');

const runpod = require('../lib/ai/runpod');

jest.mock('https');
jest.mock('fs');

/**
 * Build a mock https.request implementation that responds with the given
 * statusCode and responseBody string. Optionally stores the request body
 * on req._body for inspection by callers.
 */
function makeHttpsRequestMock(statusCode, responseBody) {
  return jest.fn((options, callback) => {
    const res = new Readable({ read() {} });
    res.statusCode = statusCode;

    const req = {
      _body: null,
      on: jest.fn().mockReturnThis(),
      write: jest.fn((data) => {
        req._body = data;
      }),
      end: jest.fn(),
    };

    // Simulate async response (after end() is called in the real world).
    // We fire synchronously here to keep tests simple — _request registers
    // res.on('data') / res.on('end') inside the callback before req.end().
    callback(res);
    res.push(typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody));
    res.push(null);

    return req;
  });
}

describe('lib/ai/runpod', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.RUNPOD_POD_ID = 'test-pod-id';

    // Default: 200 with empty JSON body — overridden per-test where needed.
    https.request.mockImplementation(makeHttpsRequestMock(200, '{}'));
  });

  afterEach(() => {
    delete process.env.RUNPOD_POD_ID;
  });

  // ── pingPod ────────────────────────────────────────────────────────────────

  describe('pingPod', () => {
    it('returns { ok: true, stats } on HTTP 200', async () => {
      https.request.mockImplementation(makeHttpsRequestMock(200, { some: 'stats' }));

      const result = await runpod.pingPod();

      expect(result.ok).toBe(true);
      expect(result.stats).toEqual({ some: 'stats' });
    });

    it('returns { ok: false } on non-200 status', async () => {
      https.request.mockImplementation(makeHttpsRequestMock(500, 'Server Error'));

      const result = await runpod.pingPod();

      expect(result.ok).toBe(false);
    });

    it('returns { ok: false, error } when the request throws a network error', async () => {
      https.request.mockImplementation((options, callback) => {
        const req = {
          _errorHandler: null,
          on: jest.fn((event, handler) => {
            if (event === 'error') req._errorHandler = handler;
            return req;
          }),
          write: jest.fn(),
          end: jest.fn(() => {
            if (req._errorHandler) req._errorHandler(new Error('Network error'));
          }),
        };
        return req;
      });

      const result = await runpod.pingPod();

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  // ── submitComfyWorkflow ────────────────────────────────────────────────────

  describe('submitComfyWorkflow', () => {
    it('returns prompt_id on HTTP 200', async () => {
      https.request.mockImplementation(makeHttpsRequestMock(200, { prompt_id: 'abc-123' }));

      const promptId = await runpod.submitComfyWorkflow({ someNode: {} });

      expect(promptId).toBe('abc-123');
    });

    it('throws on non-200 response', async () => {
      https.request.mockImplementation(makeHttpsRequestMock(422, { error: 'invalid workflow' }));

      await expect(runpod.submitComfyWorkflow({})).rejects.toThrow('ComfyUI submit failed: 422');
    });
  });

  // ── pollComfyResult ────────────────────────────────────────────────────────

  describe('pollComfyResult', () => {
    it('returns outputs when history contains the prompt_id', async () => {
      const promptId = 'poll-id-1';
      const expectedOutputs = { '8': { images: [{ filename: 'out.webp' }] } };

      // First call: history not ready yet. Second call: history populated.
      https.request
        .mockImplementationOnce(makeHttpsRequestMock(200, {}))
        .mockImplementationOnce(makeHttpsRequestMock(200, { [promptId]: { outputs: expectedOutputs } }));

      const outputs = await runpod.pollComfyResult(promptId, undefined, { intervalMs: 5, maxWaitMs: 5000 });

      expect(outputs).toEqual(expectedOutputs);
      expect(https.request).toHaveBeenCalledTimes(2);
    });

    it('throws a timeout error when the job never completes', async () => {
      https.request.mockImplementation(makeHttpsRequestMock(200, {}));

      await expect(
        runpod.pollComfyResult('missing-id', undefined, { maxWaitMs: 30, intervalMs: 5 })
      ).rejects.toThrow('ComfyUI job missing-id timed out after 30ms');
    });
  });

  // ── generateWanVideo ───────────────────────────────────────────────────────

  describe('generateWanVideo', () => {
    const MOCK_WORKFLOW = JSON.stringify({
      '3': { inputs: {} },
      '4': { inputs: {} },
      '5': { inputs: {} },
      '8': { inputs: {} },
    });

    beforeEach(() => {
      fs.readFileSync.mockReturnValue(MOCK_WORKFLOW);
      https.request.mockImplementation(makeHttpsRequestMock(200, { prompt_id: 'wan-123' }));
    });

    it('throws if positivePrompt is missing', async () => {
      await expect(runpod.generateWanVideo()).rejects.toThrow('positivePrompt is required');
    });

    it('passes the correct values into workflow nodes 3/4/5/8', async () => {
      const opts = {
        positivePrompt: 'a news anchor',
        negativePrompt: 'bad quality',
        width: 1024,
        height: 576,
        numFrames: 49,
        seed: 42,
        outputPrefix: 'my_prefix',
      };

      await runpod.generateWanVideo(opts);

      const reqMock = https.request.mock.results[0].value;
      const submitted = JSON.parse(reqMock._body).prompt;

      expect(submitted['3'].inputs.positive_prompt).toBe(opts.positivePrompt);
      expect(submitted['3'].inputs.negative_prompt).toBe(opts.negativePrompt);
      expect(submitted['4'].inputs.width).toBe(opts.width);
      expect(submitted['4'].inputs.height).toBe(opts.height);
      expect(submitted['4'].inputs.num_frames).toBe(opts.numFrames);
      expect(submitted['5'].inputs.seed).toBe(opts.seed);
      expect(submitted['8'].inputs.filename_prefix).toBe(opts.outputPrefix);
    });

    it('uses default width (832), height (480), and numFrames (25) when not specified', async () => {
      await runpod.generateWanVideo({ positivePrompt: 'test prompt' });

      const reqMock = https.request.mock.results[0].value;
      const submitted = JSON.parse(reqMock._body).prompt;

      expect(submitted['4'].inputs.width).toBe(832);
      expect(submitted['4'].inputs.height).toBe(480);
      expect(submitted['4'].inputs.num_frames).toBe(25);
    });

    it('calls submitComfyWorkflow (https.request) exactly once', async () => {
      await runpod.generateWanVideo({ positivePrompt: 'once only' });

      expect(https.request).toHaveBeenCalledTimes(1);
    });
  });
});
