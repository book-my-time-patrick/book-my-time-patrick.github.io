import { SaxesParser } from 'saxes';

export type CalendarProviderCode = 'CALENDAR_CONFIG_INVALID' | 'CALENDAR_AUTH_REQUIRED' |
  'CALENDAR_UNAVAILABLE' | 'CALENDAR_UNSUPPORTED' | 'CALENDAR_RESPONSE_INVALID' | 'CALENDAR_LIMIT_EXCEEDED';

export class CalendarProviderError extends Error {
  constructor(public readonly code: CalendarProviderCode) { super(code); this.name = 'CalendarProviderError'; }
}

export interface CalendarReference { id: string; name: string }
export interface BusyWindow { startAt: number; endAt: number }
export interface BusyInterval extends BusyWindow { allDay: boolean | null; tentative: boolean }
export interface IcloudCredentials { username: string; appPassword: string }
export type MicrosoftCloud = 'global' | 'china';
export interface MicrosoftConfig {
  cloud: MicrosoftCloud; tenantId: string; clientId: string; clientSecret: string; redirectUri: string;
}
export interface MicrosoftTokens { accessToken: string; refreshToken: string; expiresAt: number }

const DAY = 86_400_000;
const MAX_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_ITEMS = 2000;
const DAV = 'DAV:';
const CALDAV = 'urn:ietf:params:xml:ns:caldav';
const ICLOUD_ROOT = 'https://caldav.icloud.com/';
type Fetcher = typeof fetch;

function fail(code: CalendarProviderCode = 'CALENDAR_RESPONSE_INVALID'): never { throw new CalendarProviderError(code); }
function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
function validateWindow(window: BusyWindow) {
  if (!window || !Number.isSafeInteger(window.startAt) || !Number.isSafeInteger(window.endAt) ||
      window.startAt < 0 || window.endAt > 253402300799000 || window.endAt <= window.startAt || window.endAt - window.startAt > 45 * DAY) {
    fail('CALENDAR_CONFIG_INVALID');
  }
}

// One budget covers redirects, pagination and streamed bodies. Only fixed error codes escape.
class ProviderRequest {
  private deadline = Date.now() + 15_000;
  private bytes = 0;
  constructor(private fetcher: Fetcher) {}

  async text(url: URL, init: RequestInit, tokenEndpoint = false): Promise<{ response: Response; text: string }> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) fail('CALENDAR_UNAVAILABLE');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await this.fetcher(url, { ...init, redirect: 'manual', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        return { response, text: '' };
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || (tokenEndpoint && response.status === 400)) fail('CALENDAR_AUTH_REQUIRED');
        if (response.status === 403 || response.status === 405 || response.status === 501) fail('CALENDAR_UNSUPPORTED');
        fail('CALENDAR_UNAVAILABLE');
      }
      const claimedSize = Number(response.headers.get('content-length') ?? 0);
      if (claimedSize > MAX_BYTES) { await response.body?.cancel(); fail('CALENDAR_LIMIT_EXCEEDED'); }
      if (!response.body) fail();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          this.bytes += value.byteLength;
          if (size > MAX_BYTES || this.bytes > MAX_TOTAL_BYTES) fail('CALENDAR_LIMIT_EXCEEDED');
          if (Date.now() > this.deadline || controller.signal.aborted) fail('CALENDAR_UNAVAILABLE');
          chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { response, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch (error) {
      if (error instanceof CalendarProviderError) throw error;
      fail('CALENDAR_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
}

function appleUrl(value: string, base = ICLOUD_ROOT): URL {
  let url: URL;
  try { url = new URL(value, base); } catch { return fail('CALENDAR_CONFIG_INVALID'); }
  if (!boundedString(value, 2048) || url.protocol !== 'https:' || url.username || url.password ||
      url.port || url.search || url.hash || !/^(?:caldav|p\d+-caldav)\.icloud\.com$/.test(url.hostname)) {
    fail('CALENDAR_CONFIG_INVALID');
  }
  return url;
}

function appleAuthorization(credentials: IcloudCredentials) {
  if (!boundedString(credentials.username, 254) || credentials.username.includes(':') ||
      !boundedString(credentials.appPassword, 200)) fail('CALENDAR_CONFIG_INVALID');
  const bytes = new TextEncoder().encode(`${credentials.username}:${credentials.appPassword}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

async function appleRequest(request: ProviderRequest, credentials: IcloudCredentials, value: string,
  method: 'PROPFIND' | 'REPORT', body: string, depth: '0' | '1') {
  let url = appleUrl(value);
  const headers = { Authorization: appleAuthorization(credentials), Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' };
  for (let redirects = 0; redirects <= 3; redirects++) {
    const result = await request.text(url, { method, headers, body });
    if (result.response.status >= 300 && result.response.status < 400) {
      if (result.response.status === 303 || redirects === 3) fail('CALENDAR_UNSUPPORTED');
      const location = result.response.headers.get('location');
      if (!location) fail();
      url = appleUrl(location, url.href);
      continue;
    }
    if (result.response.status !== (method === 'PROPFIND' ? 207 : 200)) fail();
    return { text: result.text, url: url.href };
  }
  return fail();
}

type XmlNode = { uri: string; local: string; text: string; children: XmlNode[]; attributes: Record<string, string> };
function xmlDocument(text: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let nodes = 0;
  parser.on('doctype', () => fail());
  parser.on('error', () => fail());
  parser.on('opentag', tag => {
    if (++nodes > 4000 || stack.length > 20) fail('CALENDAR_LIMIT_EXCEEDED');
    const attributes: Record<string, string> = Object.create(null);
    for (const attribute of Object.values(tag.attributes)) {
      if (!attribute.uri) attributes[attribute.local] = attribute.value;
    }
    const node: XmlNode = { uri: tag.uri, local: tag.local, text: '', children: [], attributes };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
  });
  const append = (value: string) => { if (stack.length) stack.at(-1)!.text += value; };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => { stack.pop(); });
  try { parser.write(text).close(); }
  catch (error) { if (error instanceof CalendarProviderError) throw error; return fail(); }
  if (!root || stack.length) fail();
  return root;
}

function children(node: XmlNode, uri: string, local: string) { return node.children.filter(item => item.uri === uri && item.local === local); }
function single(node: XmlNode, uri: string, local: string) {
  const values = children(node, uri, local);
  if (values.length !== 1) fail();
  return values[0];
}
function davResponses(text: string) {
  const root = xmlDocument(text);
  if (root.uri !== DAV || root.local !== 'multistatus') fail();
  const responses = children(root, DAV, 'response');
  if (responses.length > 128) fail('CALENDAR_LIMIT_EXCEEDED');
  return responses.map(response => {
    const href = single(response, DAV, 'href').text.trim();
    const properties = children(response, DAV, 'propstat').flatMap(propstat => {
      const status = single(propstat, DAV, 'status').text.trim();
      if (/^HTTP\/\d(?:\.\d)? 404(?: |$)/.test(status)) return [];
      if (!/^HTTP\/\d(?:\.\d)? 200(?: |$)/.test(status)) fail('CALENDAR_UNSUPPORTED');
      return single(propstat, DAV, 'prop').children;
    });
    return { href, properties };
  });
}
const propfind = (properties: string) => `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${properties}</d:prop></d:propfind>`;

export async function discoverIcloudCalendars(credentials: IcloudCredentials, fetcher: Fetcher = fetch): Promise<CalendarReference[]> {
  const request = new ProviderRequest(fetcher);
  const principalResponse = await appleRequest(request, credentials, ICLOUD_ROOT, 'PROPFIND', propfind('<d:current-user-principal/>'), '0');
  const principals = davResponses(principalResponse.text).flatMap(item => item.properties)
    .filter(item => item.uri === DAV && item.local === 'current-user-principal');
  if (principals.length !== 1) fail('CALENDAR_UNSUPPORTED');
  const principal = appleUrl(single(principals[0], DAV, 'href').text.trim(), principalResponse.url);
  const homesResponse = await appleRequest(request, credentials, principal.href, 'PROPFIND', propfind('<c:calendar-home-set/>'), '0');
  const homes = davResponses(homesResponse.text).flatMap(item => item.properties)
    .filter(item => item.uri === CALDAV && item.local === 'calendar-home-set').flatMap(item => children(item, DAV, 'href'));
  if (!homes.length || homes.length > 4) fail('CALENDAR_UNSUPPORTED');
  const calendars = new Map<string, CalendarReference>();
  for (const home of homes) {
    const homeUrl = appleUrl(home.text.trim(), homesResponse.url);
    const listing = await appleRequest(request, credentials, homeUrl.href, 'PROPFIND',
      propfind('<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>'), '1');
    for (const item of davResponses(listing.text)) {
      const resource = item.properties.find(property => property.uri === DAV && property.local === 'resourcetype');
      if (!resource || !children(resource, CALDAV, 'calendar').length) continue;
      const components = item.properties.find(property => property.uri === CALDAV && property.local === 'supported-calendar-component-set');
      if (components && !children(components, CALDAV, 'comp').some(component => component.attributes.name === 'VEVENT')) continue;
      const id = appleUrl(item.href, listing.url).href;
      const name = item.properties.find(property => property.uri === DAV && property.local === 'displayname')?.text.trim() || 'iCloud 日历';
      if (!boundedString(name, 200)) fail();
      calendars.set(id, { id, name });
    }
  }
  if (calendars.size > 128) fail('CALENDAR_LIMIT_EXCEEDED');
  return [...calendars.values()];
}

function utcTimestamp(value: string): number {
  if (!/^\d{8}T\d{6}Z$/.test(value)) fail();
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) fail();
  return date.getTime();
}
function durationMilliseconds(value: string): number {
  const match = /^\+?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/.exec(value);
  if (!match) fail();
  const milliseconds = ((Number(match[1] ?? 0) * 7 + Number(match[2] ?? 0)) * 86400 +
    Number(match[3] ?? 0) * 3600 + Number(match[4] ?? 0) * 60 + Number(match[5] ?? 0)) * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 366 * DAY) fail();
  return milliseconds;
}
function compactUtc(value: number) { return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }

function freeBusyIntervals(text: string, window: BusyWindow): BusyInterval[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').trim().split(/\r?\n/);
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR' || lines.length > 5000) fail();
  let inside = false, components = 0, ended = false, versions = 0;
  const intervals: BusyInterval[] = [];
  for (const line of lines.slice(1, -1)) {
    if (line === 'BEGIN:VFREEBUSY' && !inside && !ended) { inside = true; components++; continue; }
    if (line === 'END:VFREEBUSY' && inside) { inside = false; ended = true; continue; }
    const separator = line.indexOf(':');
    if (separator <= 0 || line.length > 16000) fail();
    const property = line.slice(0, separator), value = line.slice(separator + 1);
    if (!inside) {
      if (property === 'VERSION') versions++;
      if (!(property === 'VERSION' && value === '2.0') && property !== 'PRODID' && property !== 'CALSCALE' && property !== 'METHOD') fail();
      continue;
    }
    if (property === 'DTSTART') { if (utcTimestamp(value) > window.startAt) fail(); continue; }
    if (property === 'DTEND') { if (utcTimestamp(value) < window.endAt) fail(); continue; }
    if (property === 'UID' || property === 'DTSTAMP') continue;
    const freeBusy = /^FREEBUSY(?:;FBTYPE=(FREE|BUSY|BUSY-UNAVAILABLE|BUSY-TENTATIVE))?$/.exec(property);
    if (!freeBusy) fail();
    for (const period of value.split(',')) {
      const [start, end, extra] = period.split('/');
      if (!start || !end || extra !== undefined) fail();
      const startAt = utcTimestamp(start);
      const endAt = end.startsWith('P') || end.startsWith('+P') ? startAt + durationMilliseconds(end) : utcTimestamp(end);
      if (!Number.isSafeInteger(endAt) || endAt <= startAt) fail();
      if (freeBusy[1] === 'FREE' || startAt >= window.endAt || endAt <= window.startAt) continue;
      intervals.push({ startAt: Math.max(startAt, window.startAt), endAt: Math.min(endAt, window.endAt),
        allDay: null, tentative: freeBusy[1] === 'BUSY-TENTATIVE' });
      if (intervals.length > MAX_ITEMS) fail('CALENDAR_LIMIT_EXCEEDED');
    }
  }
  if (inside || !ended || components !== 1 || versions !== 1) fail();
  return intervals;
}

export async function readIcloudBusy(credentials: IcloudCredentials, calendarId: string, window: BusyWindow,
  fetcher: Fetcher = fetch): Promise<BusyInterval[]> {
  validateWindow(window);
  const body = `<?xml version="1.0" encoding="utf-8"?><c:free-busy-query xmlns:c="urn:ietf:params:xml:ns:caldav"><c:time-range start="${compactUtc(Math.floor(window.startAt / 1000) * 1000)}" end="${compactUtc(Math.ceil(window.endAt / 1000) * 1000)}"/></c:free-busy-query>`;
  const response = await appleRequest(new ProviderRequest(fetcher), credentials, calendarId, 'REPORT', body, '1');
  return freeBusyIntervals(response.text, window);
}

function microsoftHosts(cloud: MicrosoftCloud) {
  if (cloud === 'global') return { authority: 'https://login.microsoftonline.com', graph: 'https://graph.microsoft.com' };
  if (cloud === 'china') return { authority: 'https://login.chinacloudapi.cn', graph: 'https://microsoftgraph.chinacloudapi.cn' };
  return fail('CALENDAR_CONFIG_INVALID');
}
function microsoftEndpoints(config: MicrosoftConfig) {
  const hosts = microsoftHosts(config.cloud);
  let redirect: URL;
  try { redirect = new URL(config.redirectUri); } catch { return fail('CALENDAR_CONFIG_INVALID'); }
  if (!boundedString(config.tenantId, 253) || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(config.tenantId) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.clientId) || !boundedString(config.clientSecret, 4096) ||
      (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname))) ||
      redirect.username || redirect.password || redirect.search || redirect.hash) fail('CALENDAR_CONFIG_INVALID');
  const base = `${hosts.authority}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0`;
  return { ...hosts, authorization: `${base}/authorize`, token: `${base}/token`, scope: `${hosts.graph}/Calendars.ReadBasic offline_access` };
}

export function microsoftAuthorizationUrl(config: MicrosoftConfig, state: string, codeChallenge: string) {
  const endpoints = microsoftEndpoints(config);
  if (!boundedString(state, 512) || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) fail('CALENDAR_CONFIG_INVALID');
  const url = new URL(endpoints.authorization);
  url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', response_mode: 'query',
    redirect_uri: config.redirectUri, scope: endpoints.scope, state, code_challenge: codeChallenge,
    code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return url.href;
}

function jsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
async function exchangeToken(config: MicrosoftConfig, parameters: Record<string, string>, oldRefreshToken: string | undefined,
  fetcher: Fetcher): Promise<MicrosoftTokens> {
  const endpoints = microsoftEndpoints(config);
  const response = await new ProviderRequest(fetcher).text(new URL(endpoints.token), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, scope: endpoints.scope, ...parameters }),
  }, true);
  if (response.response.status !== 200) fail();
  const data = jsonObject(response.text);
  const refreshToken = data.refresh_token ?? oldRefreshToken;
  if (!boundedString(data.access_token, 32768) || !boundedString(refreshToken, 32768) ||
      typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
      typeof data.expires_in !== 'number' || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400) fail();
  return { accessToken: data.access_token, refreshToken, expiresAt: Date.now() + data.expires_in * 1000 };
}
export function exchangeMicrosoftCode(config: MicrosoftConfig, code: string, verifier: string, fetcher: Fetcher = fetch) {
  if (!boundedString(code, 8192) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) fail('CALENDAR_CONFIG_INVALID');
  return exchangeToken(config, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.redirectUri }, undefined, fetcher);
}
export function refreshMicrosoftToken(config: MicrosoftConfig, refreshToken: string, fetcher: Fetcher = fetch) {
  if (!boundedString(refreshToken, 32768)) fail('CALENDAR_CONFIG_INVALID');
  return exchangeToken(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken, fetcher);
}

async function graphCollection(cloud: MicrosoftCloud, accessToken: string, path: string, parameters: URLSearchParams, fetcher: Fetcher) {
  if (!boundedString(accessToken, 32768)) fail('CALENDAR_CONFIG_INVALID');
  const host = microsoftHosts(cloud).graph;
  const initial = new URL(`${host}/v1.0/me/${path}`);
  initial.search = parameters.toString();
  const request = new ProviderRequest(fetcher);
  let url = initial;
  const collection: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  for (let page = 0; page < 5; page++) {
    if (visited.has(url.href)) fail();
    visited.add(url.href);
    const result = await request.text(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', Prefer: 'outlook.timezone="UTC"' } });
    if (result.response.status !== 200) fail();
    const data = jsonObject(result.text);
    if (!Array.isArray(data.value) || data.value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) fail();
    collection.push(...data.value);
    if (collection.length > MAX_ITEMS) fail('CALENDAR_LIMIT_EXCEEDED');
    if (!('@odata.nextLink' in data)) return collection;
    if (!boundedString(data['@odata.nextLink'], 8192)) fail();
    try { url = new URL(data['@odata.nextLink']); } catch { return fail(); }
    if (url.origin !== host || url.username || url.password || url.hash || url.pathname !== initial.pathname ||
        url.searchParams.get('$select') !== initial.searchParams.get('$select')) fail();
    for (const field of ['startDateTime', 'endDateTime']) {
      if (url.searchParams.get(field) !== initial.searchParams.get(field)) fail();
    }
  }
  return fail('CALENDAR_LIMIT_EXCEEDED');
}

export async function listMicrosoftCalendars(cloud: MicrosoftCloud, accessToken: string, fetcher: Fetcher = fetch): Promise<CalendarReference[]> {
  const rows = await graphCollection(cloud, accessToken, 'calendars', new URLSearchParams({ '$select': 'id,name', '$top': '100' }), fetcher);
  if (rows.length > 128) fail('CALENDAR_LIMIT_EXCEEDED');
  const ids = new Set<string>();
  return rows.map(row => {
    if (!boundedString(row.id, 2048) || !boundedString(row.name, 200) || ids.has(row.id)) return fail();
    ids.add(row.id);
    return { id: row.id, name: row.name };
  });
}

function graphTime(value: unknown, end = false): number {
  if (!value || typeof value !== 'object') fail();
  const date = value as { dateTime: unknown; timeZone: unknown };
  if (date.timeZone !== 'UTC' || typeof date.dateTime !== 'string') fail();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z?$/.exec(date.dateTime);
  if (!match) fail();
  const fraction = (match[2] ?? '').padEnd(3, '0');
  const iso = `${match[1]}.${fraction.slice(0, 3)}Z`;
  const result = new Date(iso);
  if (!Number.isFinite(result.getTime()) || result.toISOString() !== iso) fail();
  return result.getTime() + (end && /[1-9]/.test(fraction.slice(3)) ? 1 : 0);
}

export async function readMicrosoftBusy(cloud: MicrosoftCloud, accessToken: string, calendarId: string, window: BusyWindow,
  fetcher: Fetcher = fetch): Promise<BusyInterval[]> {
  validateWindow(window);
  if (!boundedString(calendarId, 2048)) fail('CALENDAR_CONFIG_INVALID');
  const fields = ['start', 'end', 'isAllDay', 'showAs', 'isCancelled'];
  const rows = await graphCollection(cloud, accessToken, `calendars/${encodeURIComponent(calendarId)}/calendarView`, new URLSearchParams({
    startDateTime: new Date(window.startAt).toISOString(), endDateTime: new Date(window.endAt).toISOString(),
    '$select': fields.join(','), '$top': '200',
  }), fetcher);
  const intervals: BusyInterval[] = [];
  for (const row of rows) {
    if (Object.keys(row).some(key => key !== 'id' && !key.startsWith('@odata.') && !fields.includes(key))) fail();
    if (typeof row.isAllDay !== 'boolean' || typeof row.isCancelled !== 'boolean' ||
        typeof row.showAs !== 'string' || !['free', 'busy', 'tentative', 'oof', 'workingElsewhere'].includes(row.showAs)) fail();
    const startAt = graphTime(row.start), endAt = graphTime(row.end, true);
    if (endAt <= startAt) fail();
    if (row.isCancelled || row.showAs === 'free' || startAt >= window.endAt || endAt <= window.startAt) continue;
    intervals.push({ startAt: Math.max(startAt, window.startAt), endAt: Math.min(endAt, window.endAt),
      allDay: row.isAllDay, tentative: row.showAs === 'tentative' });
  }
  return intervals;
}
