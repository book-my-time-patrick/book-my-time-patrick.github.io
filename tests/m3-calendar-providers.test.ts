import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CalendarProviderError, discoverIcloudCalendars, readIcloudBusy,
  microsoftAuthorizationUrl, exchangeMicrosoftCode, refreshMicrosoftToken,
  listMicrosoftCalendars, readMicrosoftBusy,
} from '../server/calendar-providers.js';
import type { MicrosoftConfig, CalendarProviderCode } from '../server/calendar-providers.js';

const credentials = { username: 'synthetic@example.test', appPassword: 'synthetic-app-password' };
const calendarId = 'https://p01-caldav.icloud.com/123/calendars/personal/';
const startAt = Date.parse('2026-11-10T00:00:00Z');
const endAt = Date.parse('2026-11-11T00:00:00Z');
const window = { startAt, endAt };
const config: MicrosoftConfig = { cloud: 'global', tenantId: 'common', clientId: '00000000-0000-4000-8000-000000000001',
  clientSecret: 'synthetic-client-secret', redirectUri: 'https://booking.example.test/api/admin/calendars/microsoft/callback' };
const codeError = (code: CalendarProviderCode) => (error: unknown) => error instanceof CalendarProviderError && error.code === code && error.message === code;
const mockFetch = (handle: (url: URL, init: RequestInit) => Response | Promise<Response>) =>
  (async (input: string | URL | Request, init?: RequestInit) => handle(new URL(input instanceof Request ? input.url : input), init ?? {})) as typeof fetch;
const xml = (body: string) => `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;
const properties = (href: string, body: string) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${body}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const freeBusy = (body = '') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VFREEBUSY', 'UID:synthetic',
  'DTSTAMP:20261109T000000Z', 'DTSTART:20261110T000000Z', 'DTEND:20261111T000000Z', body,
  'END:VFREEBUSY', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
const event = (overrides: Record<string, unknown> = {}) => ({ start: { dateTime: '2026-11-10T09:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-10T10:00:00.0000000', timeZone: 'UTC' }, isAllDay: false, isCancelled: false, showAs: 'busy', ...overrides });

test('iCloud discovers DAV calendars with namespaces, decoded names and bounded Apple redirects', async () => {
  const calls: string[] = [];
  const calendars = await discoverIcloudCalendars(credentials, mockFetch((url, init) => {
    calls.push(url.href);
    assert.equal(init.method, 'PROPFIND');
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('Authorization'), `Basic ${btoa(`${credentials.username}:${credentials.appPassword}`)}`);
    if (calls.length === 1) return new Response(null, { status: 307, headers: { Location: 'https://p01-caldav.icloud.com/' } });
    if (calls.length === 2) return new Response(xml(properties('/', '<D:current-user-principal><D:href>/123/principal/</D:href></D:current-user-principal>')), { status: 207 });
    if (calls.length === 3) return new Response(xml(properties('/123/principal/', '<C:calendar-home-set><D:href>/123/calendars/</D:href></C:calendar-home-set>')), { status: 207 });
    assert.equal(new Headers(init.headers).get('Depth'), '1');
    assert.ok(String(init.body).includes('supported-calendar-component-set'));
    return new Response(xml(
      properties('/123/calendars/', '<D:resourcetype><D:collection/></D:resourcetype>') +
      properties('/123/calendars/personal/', '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Private &amp; Home</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>') +
      properties('/123/calendars/tasks/', '<D:resourcetype><C:calendar/></D:resourcetype><D:displayname>Reminders</D:displayname><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>')), { status: 207 });
  }));
  assert.deepEqual(calendars, [{ id: calendarId, name: 'Private & Home' }]);
  assert.equal(calls.length, 4);
});

test('iCloud never sends credentials to a discovered or redirected non-Apple host', async () => {
  for (const destination of ['https://evil.example.test/', 'https://caldav.icloud.com.evil.test/', 'http://caldav.icloud.com/',
    'https://user@caldav.icloud.com/', 'https://caldav.icloud.com:8443/', 'https://caldav.icloud.com/#secret']) {
    let calls = 0;
    await assert.rejects(discoverIcloudCalendars(credentials, mockFetch(() => {
      calls++;
      return new Response(null, { status: 307, headers: { Location: destination } });
    })), codeError('CALENDAR_CONFIG_INVALID'));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(discoverIcloudCalendars(credentials, mockFetch(() => {
    calls++;
    return new Response(xml(properties('/', '<D:current-user-principal><D:href>https://evil.example.test/</D:href></D:current-user-principal>')), { status: 207 });
  })), codeError('CALENDAR_CONFIG_INVALID'));
  assert.equal(calls, 1);
});

test('iCloud discovery rejects external entities, malformed namespaces and missing supported properties', async () => {
  const documents = [
    '<!DOCTYPE x [<!ENTITY dangerous SYSTEM "https://evil.example.test">]><x>&dangerous;</x>',
    '<D:multistatus><D:response/></D:multistatus>',
    xml(properties('/', '<D:current-user-principal><D:href>/a</D:href><D:href>/b</D:href></D:current-user-principal>')),
  ];
  for (const document of documents) await assert.rejects(discoverIcloudCalendars(credentials,
    mockFetch(() => new Response(document, { status: 207 }))), codeError('CALENDAR_RESPONSE_INVALID'));
  await assert.rejects(discoverIcloudCalendars(credentials, mockFetch(() => new Response(xml(properties('/', '')), { status: 207 }))), codeError('CALENDAR_UNSUPPORTED'));
});

test('iCloud uses only free-busy reports, preserves tentative intervals, handles folding/durations and valid empty results', async () => {
  let calls = 0;
  const rows = await readIcloudBusy(credentials, calendarId, window, mockFetch((_url, init) => {
    calls++;
    assert.equal(init.method, 'REPORT');
    assert.ok(String(init.body).includes('free-busy-query'));
    assert.ok(!String(init.body).includes('calendar-query'));
    return new Response(freeBusy('FREEBUSY:20261109T230000Z/20261110T010000Z\r\nFREEBUSY;FBTYPE=BUSY-TENTATIVE:20261110T090000Z/PT1H,\r\n 20261110T120000Z/PT30M\r\nFREEBUSY;FBTYPE=FREE:20261110T140000Z/PT1H'));
  }));
  assert.equal(calls, 1);
  assert.deepEqual(rows, [
    { startAt, endAt: startAt + 3_600_000, allDay: null, tentative: false },
    { startAt: startAt + 9 * 3_600_000, endAt: startAt + 10 * 3_600_000, allDay: null, tentative: true },
    { startAt: startAt + 12 * 3_600_000, endAt: startAt + 12.5 * 3_600_000, allDay: null, tentative: true },
  ]);
  assert.deepEqual(await readIcloudBusy(credentials, calendarId, window, mockFetch(() => new Response(freeBusy()))), []);
});

test('iCloud fails closed on full events, unknown busy type, invalid periods, incomplete coverage or unsupported reports', async () => {
  for (const body of [
    'BEGIN:VEVENT\r\nSUMMARY:Synthetic private title\r\nEND:VEVENT',
    'FREEBUSY;FBTYPE=UNKNOWN:20261110T090000Z/PT1H',
    'FREEBUSY:20261110T090000Z/20261110T080000Z',
    'FREEBUSY:20261310T090000Z/PT1H',
    'FREEBUSY:20261110T090000Z/PT0S',
    'SUMMARY:Synthetic forbidden detail',
  ]) await assert.rejects(readIcloudBusy(credentials, calendarId, window, mockFetch(() => new Response(freeBusy(body)))), codeError('CALENDAR_RESPONSE_INVALID'));
  await assert.rejects(readIcloudBusy(credentials, calendarId, window,
    mockFetch(() => new Response(freeBusy().replace('DTEND:20261111T000000Z', 'DTEND:20261110T120000Z')))), codeError('CALENDAR_RESPONSE_INVALID'));
  let calls = 0;
  await assert.rejects(readIcloudBusy(credentials, calendarId, window, mockFetch(() => { calls++; return new Response('', { status: 403 }); })), codeError('CALENDAR_UNSUPPORTED'));
  assert.equal(calls, 1);
});

test('provider budgets reject oversized responses, overlong windows, redirects and sensitive exception messages', async () => {
  await assert.rejects(readIcloudBusy(credentials, calendarId, window,
    mockFetch(() => new Response('x'.repeat(128 * 1024 + 1)))), codeError('CALENDAR_LIMIT_EXCEEDED'));
  await assert.rejects(readIcloudBusy(credentials, calendarId, { startAt, endAt: startAt + 46 * 86_400_000 },
    mockFetch(() => { throw new Error('must not call'); })), codeError('CALENDAR_CONFIG_INVALID'));
  await assert.rejects(readIcloudBusy(credentials, calendarId, window,
    mockFetch(() => { throw new Error('synthetic secret must not escape'); })), codeError('CALENDAR_UNAVAILABLE'));
  await assert.rejects(discoverIcloudCalendars(credentials,
    mockFetch(() => new Response(null, { status: 302, headers: { Location: '/' } }))), codeError('CALENDAR_UNSUPPORTED'));
});

test('Microsoft authorization separates clouds, requires PKCE and limits requested permissions', () => {
  for (const cloud of ['global', 'china'] as const) {
    const url = new URL(microsoftAuthorizationUrl({ ...config, cloud }, 'synthetic-state', 'a'.repeat(43)));
    assert.equal(url.hostname, cloud === 'global' ? 'login.microsoftonline.com' : 'login.chinacloudapi.cn');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
    assert.equal(url.searchParams.get('scope'), `${cloud === 'global' ? 'https://graph.microsoft.com' : 'https://microsoftgraph.chinacloudapi.cn'}/Calendars.ReadBasic offline_access`);
    assert.equal(url.searchParams.get('client_secret'), null);
  }
  assert.throws(() => microsoftAuthorizationUrl({ ...config, redirectUri: 'http://booking.example.test/' }, 's', 'a'.repeat(43)), codeError('CALENDAR_CONFIG_INVALID'));
  assert.throws(() => microsoftAuthorizationUrl(config, 's', 'weak'), codeError('CALENDAR_CONFIG_INVALID'));
});

test('Microsoft code exchange and refresh return only validated tokens and preserve rotation', async () => {
  const tokens = await exchangeMicrosoftCode(config, 'synthetic-code', 'a'.repeat(43), mockFetch((url, init) => {
    assert.equal(url.hostname, 'login.microsoftonline.com');
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code_verifier'), 'a'.repeat(43));
    assert.equal(form.get('client_secret'), config.clientSecret);
    return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'Bearer', id_token: 'unused' });
  }));
  assert.deepEqual(Object.keys(tokens).sort(), ['accessToken', 'expiresAt', 'refreshToken']);
  assert.equal(tokens.refreshToken, 'synthetic-refresh');
  assert.ok(tokens.expiresAt > Date.now());
  const rotated = await refreshMicrosoftToken(config, tokens.refreshToken, mockFetch((_url, init) => {
    assert.equal(new URLSearchParams(String(init.body)).get('refresh_token'), tokens.refreshToken);
    return Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer' });
  }));
  assert.equal(rotated.refreshToken, 'rotated-refresh');
  const retained = await refreshMicrosoftToken(config, tokens.refreshToken, mockFetch(() => Response.json({ access_token: 'new-access', expires_in: 3600, token_type: 'Bearer' })));
  assert.equal(retained.refreshToken, tokens.refreshToken);
  await assert.rejects(refreshMicrosoftToken(config, tokens.refreshToken, mockFetch(() => Response.json({ error: 'invalid_grant', error_description: 'private detail' }, { status: 400 }))), codeError('CALENDAR_AUTH_REQUIRED'));
  await assert.rejects(refreshMicrosoftToken(config, tokens.refreshToken, mockFetch(() => Response.json({ access_token: 'x', token_type: 'Bearer', expires_in: -1 }))), codeError('CALENDAR_RESPONSE_INVALID'));
});

test('Microsoft paginated calendar discovery and projected event view preserve busy/all-day states', async () => {
  let pages = 0;
  const calendars = await listMicrosoftCalendars('global', 'synthetic-access', mockFetch(url => {
    assert.equal(url.searchParams.get('$select'), 'id,name');
    pages++;
    if (pages === 1) { const next = new URL(url); next.searchParams.set('$skiptoken', 'page2'); return Response.json({ value: [{ id: 'a', name: 'Work' }], '@odata.nextLink': next.href }); }
    return Response.json({ value: [{ id: 'b', name: 'Personal' }] });
  }));
  assert.equal(calendars.length, 2);
  const intervals = await readMicrosoftBusy('china', 'synthetic-access', 'calendar-id', window, mockFetch((url, init) => {
    assert.equal(url.hostname, 'microsoftgraph.chinacloudapi.cn');
    assert.equal(url.searchParams.get('$select'), 'start,end,isAllDay,showAs,isCancelled');
    assert.equal(new Headers(init.headers).get('Prefer'), 'outlook.timezone="UTC"');
    return Response.json({ value: [event(), event({ showAs: 'free' }), event({ isCancelled: true }), event({ showAs: 'tentative', isAllDay: true })] });
  }));
  assert.equal(intervals.length, 2);
  assert.deepEqual(intervals.map(item => [item.allDay, item.tentative]), [[false, false], [true, true]]);
  assert.deepEqual(Object.keys(intervals[0]).sort(), ['allDay', 'endAt', 'startAt', 'tentative']);
  assert.deepEqual(await readMicrosoftBusy('global', 'a', 'b', window, mockFetch(() => Response.json({ value: [] }))), []);
});

test('Microsoft does not treat missing, unknown or unprojected event fields as an empty successful snapshot', async () => {
  for (const row of [event({ showAs: 'unknown' }), event({ showAs: undefined }), event({ start: undefined }),
    event({ isAllDay: undefined }), event({ isCancelled: undefined }), event({ subject: 'Synthetic forbidden detail' }),
    event({ start: { dateTime: '2026-02-30T09:00:00', timeZone: 'UTC' } }),
    event({ end: { dateTime: '2026-11-10T08:00:00', timeZone: 'UTC' } }),
    event({ start: { dateTime: '2026-11-10T09:00:00', timeZone: 'Pacific Standard Time' } }),
  ]) await assert.rejects(readMicrosoftBusy('global', 'access', 'id', window, mockFetch(() => Response.json({ value: [event(), row] }))), codeError('CALENDAR_RESPONSE_INVALID'));
});

test('Microsoft pagination refuses credentials to other origins and refuses incomplete or altered queries', async () => {
  for (const mutate of [
    (url: URL) => { url.hostname = 'evil.example.test'; },
    (url: URL) => { url.pathname = '/v1.0/me/messages'; },
    (url: URL) => { url.searchParams.delete('$select'); },
    (url: URL) => { url.searchParams.set('endDateTime', '2026-11-10T01:00:00Z'); },
  ]) {
    let calls = 0;
    await assert.rejects(readMicrosoftBusy('global', 'access', 'id', window, mockFetch(url => {
      calls++;
      const next = new URL(url); mutate(next);
      return Response.json({ value: [], '@odata.nextLink': next.href });
    })), codeError('CALENDAR_RESPONSE_INVALID'));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(readMicrosoftBusy('global', 'access', 'id', window, mockFetch(url => {
    calls++;
    const next = new URL(url); next.searchParams.set('$skiptoken', String(calls));
    return Response.json({ value: [event()], '@odata.nextLink': next.href });
  })), codeError('CALENDAR_LIMIT_EXCEEDED'));
  assert.equal(calls, 5);
  await assert.rejects(readMicrosoftBusy('global', 'access', 'id', window,
    mockFetch(() => new Response(null, { status: 302, headers: { Location: 'https://evil.example.test/' } }))), codeError('CALENDAR_RESPONSE_INVALID'));
});
