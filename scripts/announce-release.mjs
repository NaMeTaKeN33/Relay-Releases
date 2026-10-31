import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const logoName = 'arcane-tech-discord.png';

export function chunks(text, limit = 3400) {
  const result = [];
  let remaining = text;
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf('\n', limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    result.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
    if (remaining.startsWith('\n')) remaining = remaining.slice(1);
  }
  if (remaining) result.push(remaining);
  return result;
}

export function payloads(release) {
  if (release.draft || release.prerelease) throw new Error('Only published stable releases can be announced.');
  const version = String(release.tag_name ?? '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid release version.');
  if (!release.id || !release.published_at) throw new Error('Published release metadata is missing.');
  const url = new URL(release.html_url);
  if (url.origin !== 'https://github.com') throw new Error('Invalid release link.');
  const notes = String(release.body ?? '').trim() || 'See the release page for details.';
  const parts = chunks(notes);
  const installer = release.assets?.find(asset => asset.name === 'Relay-stable-Setup.exe');
  return parts.map((part, index) => ({
    username: 'Arcane AIO',
    allowed_mentions: { parse: [] },
    attachments: [{ id: 0, filename: logoName }],
    embeds: [{
      title: `🚀\u00a0\u00a0Arcane AIO ${version}${parts.length > 1 ? ` (${index + 1}/${parts.length})` : ''}`,
      url: release.html_url,
      color: 0xC08CCD, // AppTheme's dark-mode Accent (navigation indicator).
      description: `${index === 0 ? 'A new update is available. Update in the app or download it below.\n\n' : ''}**Changelog**\n${part}`,
      ...(index === 0 ? { fields: [{ name: 'Download', value: `[View release](${release.html_url})${installer ? ` • [Windows installer](${installer.browser_download_url})` : ''}` }] } : {}),
      footer: { text: 'Arcane Tech.', icon_url: `attachment://${logoName}` },
      timestamp: release.published_at,
    }],
  }));
}

export function webhookUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Release webhook is not configured.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.username || url.password || url.port || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname))
    throw new Error('Release webhook must be a Discord HTTPS webhook.');
  url.searchParams.set('wait', 'true');
  return url;
}

export async function send(url, payload, logo, fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append('files[0]', new Blob([logo], { type: 'image/png' }), logoName);
    let response;
    try {
      response = await fetcher(url, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(30000) });
    } catch {
      throw new Error('Discord connection failed. Check the channel before retrying to avoid a duplicate.');
    }
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      const seconds = Number(data.retry_after);
      if (attempt === 3 || !Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('Discord rate limit reached. Retry later.');
      await sleep(Math.ceil(seconds * 1000) + 100);
      continue;
    }
    if (!response.ok) throw new Error(`Discord rejected the announcement (HTTP ${response.status}).`);
    const message = await response.json();
    if (!message.id) throw new Error('Discord did not confirm a message ID. Check the channel before retrying.');
    return String(message.id);
  }
}

export async function announce(release, { preview, statePath, logoPath, webhook, fetcher, sleep }) {
  const messages = payloads(release);
  if (preview) return messages;
  const url = webhookUrl(webhook);
  const logo = await readFile(logoPath);
  let state = { releaseId: String(release.id), messageIds: [] };
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Announcement receipt could not be read.'); }
  if (state.releaseId !== String(release.id) || !Array.isArray(state.messageIds)) throw new Error('Announcement receipt does not match this release.');
  for (let i = state.messageIds.length; i < messages.length; i++) {
    state.messageIds.push(await send(url, messages[i], logo, fetcher, sleep));
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2));
  }
  return state;
}

async function main() {
  const [releasePath, ...flags] = process.argv.slice(2);
  if (!releasePath) throw new Error('Usage: node scripts/announce-release.mjs release.json [--preview]');
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  const preview = flags.includes('--preview');
  const result = await announce(release, {
    preview,
    statePath: resolve('.announcement-state', `${release.id}.json`),
    logoPath: resolve('Assets/Brand', logoName),
    webhook: process.env.DISCORD_RELEASE_WEBHOOK_URL,
  });
  if (preview) {
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/release-announcement-preview.json', JSON.stringify(result, null, 2));
    console.log(`Preview generated: ${result.length} message(s). Nothing sent.`);
  } else console.log(`Release announcement confirmed: ${result.messageIds.length} message(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
