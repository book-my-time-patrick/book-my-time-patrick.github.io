export type CalendarStatus = 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED';

const encoder = new TextEncoder();

function utc(value: number): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function text(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[,;]/g, '\\$&');
}

function mailto(address: string) {
  const [local, domain] = address.split('@');
  return `mailto:${encodeURIComponent(local)}@${domain}`;
}

function fold(line: string): string {
  let size = 0, result = '';
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > 75) { result += '\r\n '; size = 1; }
    result += char;
    size += bytes;
  }
  return result;
}

export function calendarFile(event: {
  uid: string; organizer: string; recipient: string; summary: string;
  startAt: number; endAt: number; stamp: number; sequence: number; status: CalendarStatus;
}): string {
  const cancel = event.status === 'CANCELLED';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Private Appointments//Booking//EN',
    `METHOD:${cancel ? 'CANCEL' : 'PUBLISH'}`, 'BEGIN:VEVENT',
    `UID:${text(event.uid)}`, `DTSTAMP:${utc(event.stamp)}`,
    `DTSTART:${utc(event.startAt)}`, `DTEND:${utc(event.endAt)}`,
    `ORGANIZER:${mailto(event.organizer)}`, `SUMMARY:${text(event.summary)}`,
    `STATUS:${event.status}`, `SEQUENCE:${event.sequence}`, 'CLASS:PRIVATE',
    `TRANSP:${event.status === 'CONFIRMED' ? 'OPAQUE' : 'TRANSPARENT'}`,
  ];
  if (cancel) lines.push(`ATTENDEE:${mailto(event.recipient)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function calendarAttachment(content: string) {
  const bytes = encoder.encode(content);
  return { filename: 'appointment.ics', content: btoa(String.fromCharCode(...bytes)), content_type: 'text/calendar' };
}
