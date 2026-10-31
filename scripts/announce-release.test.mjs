import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payloads, chunks, webhookUrl, send, announce } from './announce-release.mjs';

const release = { id: 12, tag_name: 'v0.0.19', html_url: 'https://github.com/example/releases/tag/0.0.19', published_at: '2026-10-30T20:00:00Z', body: '- Fixed shipping\n- Improved settings', assets: [{ name: 'Relay-stable-Setup.exe', browser_download_url: 'https://github.com/example/setup.exe' }] };
const webhook = 'https://discord.com/api/webhooks/123/test-token';
test('release post has changelog, app accent, links and attached footer logo', () => {
  const [payload] = payloads(release);
  assert.equal(payload.embeds[0].title, '🚀\u00a0\u00a0Arcane AIO 0.0.19');
  assert.ok(payload.embeds[0].description.endsWith(release.body));
  assert.equal(payload.embeds[0].color, 0xC08CCD);
  assert.deepEqual(payload.embeds[0].footer, { text: 'Arcane Tech.', icon_url: 'attachment://arcane-tech-discord.png' });
  assert.ok(payload.embeds[0].fields[0].value.includes('Windows installer'));
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});
test('drafts and prereleases never announce', () => {
  for (const flag of ['draft', 'prerelease']) assert.throws(() => payloads({ ...release, [flag]: true }));
});
test('long changelogs preserve all characters and stay within embed limits', () => {
  const body = '🚀'.repeat(6000);
  assert.equal(chunks(body).join(''), body);
  for (const payload of payloads({ ...release, body })) {
    assert.ok(payload.embeds[0].description.length < 4096);
    assert.ok(!/[\uD800-\uDBFF]$/.test(payload.embeds[0].description));
  }
});
test('webhook validator prevents forwarding secrets to other hosts', () => {
  assert.equal(webhookUrl(webhook).searchParams.get('wait'), 'true');
  for (const value of ['http://discord.com/api/webhooks/1/token', 'https://example.com/api/webhooks/1/token', 'https://discord.com@evil.com/api/webhooks/1/token']) assert.throws(() => webhookUrl(value));
});
test('multipart includes the real logo and waits for a confirmed message', async () => {
  const id = await send(webhookUrl(webhook), payloads(release)[0], Buffer.from('logo'), async (url, options) => {
    assert.equal(url.searchParams.get('wait'), 'true');
    assert.equal(options.redirect, 'error');
    assert.equal(await options.body.get('files[0]').text(), 'logo');
    assert.equal(JSON.parse(options.body.get('payload_json')).username, 'Arcane AIO');
    return new Response(JSON.stringify({ id: '12345' }));
  });
  assert.equal(id, '12345');
});
test('rate limits retry but ambiguous connection failures do not', async () => {
  let calls = 0;
  await send(webhookUrl(webhook), {}, Buffer.alloc(0), async () => ++calls === 1 ? new Response('{"retry_after":0.01}', { status: 429 }) : new Response('{"id":"1"}'), async () => {});
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(send(webhookUrl(webhook), {}, Buffer.alloc(0), async () => { calls++; throw new Error(webhook); }), error => !error.message.includes('test-token'));
  assert.equal(calls, 1);
});
test('preview sends nothing, successful reruns reuse receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-announcement-'));
  try {
    const logoPath = join(directory, 'logo.png');
    const statePath = join(directory, 'state.json');
    await writeFile(logoPath, 'logo');
    let calls = 0;
    const options = { webhook, logoPath, statePath, fetcher: async () => { calls++; return new Response('{"id":"99"}'); } };
    await announce(release, { ...options, preview: true });
    assert.equal(calls, 0);
    await announce(release, options);
    await announce(release, options);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(await readFile(statePath)), { releaseId: '12', messageIds: ['99'] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
