/**
 * CPD-865: expired Twitch app token (401) must auto-refresh via client_credentials
 * and retry, instead of blocking VOD jobs until a manual re-mint.
 */
jest.mock('axios');
const axios = require('axios');
const TwitchClient = require('../lib/clients/twitch_client');

const ENV_KEYS = ['TWITCH_CLIENT_ID', 'TWITCH_TOKEN', 'TWITCH_CLIENT_SECRET',
  'TWITCH_OAUTH_CLIENT_ID', 'TWITCH_OAUTH_CLIENT_SECRET'];
const envBackup = {};

beforeEach(() => {
  jest.resetAllMocks();
  for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

const err401 = () => Object.assign(new Error('Request failed with status code 401'), {
  response: { status: 401 },
});

test('401 → mints new token with same-app secret and retries', async () => {
  process.env.TWITCH_CLIENT_SECRET = 'secret-A';
  const client = new TwitchClient({ clientId: 'app-A', token: 'expired', maxRetries: 1 });

  axios.get
    .mockRejectedValueOnce(err401())
    .mockResolvedValueOnce({ data: { data: [{ id: '123', login: 'alpha' }] } });
  axios.post.mockResolvedValueOnce({ data: { access_token: 'fresh-token', expires_in: 5184000 } });

  const user = await client.getUserByLogin('alpha');

  expect(user.id).toBe('123');
  expect(client.token).toBe('fresh-token');
  expect(process.env.TWITCH_TOKEN).toBe('fresh-token');
  expect(axios.post).toHaveBeenCalledWith(
    'https://id.twitch.tv/oauth2/token',
    expect.stringContaining('grant_type=client_credentials'),
    expect.any(Object)
  );
  // Retry used the fresh token
  const lastGet = axios.get.mock.calls[axios.get.mock.calls.length - 1];
  expect(lastGet[1].headers.Authorization).toBe('Bearer fresh-token');
});

test('falls back to TWITCH_OAUTH pair and switches Client-Id to match', async () => {
  process.env.TWITCH_OAUTH_CLIENT_ID = 'app-B';
  process.env.TWITCH_OAUTH_CLIENT_SECRET = 'secret-B';
  const client = new TwitchClient({ clientId: 'app-A', token: 'expired', maxRetries: 1 });

  axios.get
    .mockRejectedValueOnce(err401())
    .mockResolvedValueOnce({ data: { data: [{ id: '9' }] } });
  axios.post.mockResolvedValueOnce({ data: { access_token: 'tok-B', expires_in: 1000 } });

  await client.getUserByLogin('bravo');

  expect(client.clientId).toBe('app-B'); // header app must match token app
  const lastGet = axios.get.mock.calls[axios.get.mock.calls.length - 1];
  expect(lastGet[1].headers['Client-Id']).toBe('app-B');
});

// note: TwitchClient coerces maxRetries 0 → 3, so use 1 and allow backoff time
test('non-401 errors do not trigger a refresh', async () => {
  process.env.TWITCH_CLIENT_SECRET = 'secret-A';
  const client = new TwitchClient({ clientId: 'app-A', token: 'tok', maxRetries: 1 });

  axios.get.mockRejectedValue(Object.assign(new Error('500'), { response: { status: 500 } }));

  await expect(client.getUserByLogin('x')).rejects.toThrow();
  expect(axios.post).not.toHaveBeenCalled();
}, 15000);

test('no secrets configured: 401 propagates without refresh attempt', async () => {
  const client = new TwitchClient({ clientId: 'app-A', token: 'expired', maxRetries: 1 });

  axios.get.mockRejectedValue(err401());

  await expect(client.getUserByLogin('x')).rejects.toThrow('401');
  expect(axios.post).not.toHaveBeenCalled();
}, 15000);
