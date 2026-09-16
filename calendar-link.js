// Googleカレンダーの予定作成画面（追加権限やアクセストークン不要）
const excerpt = (value, max) => {
  const chars = Array.from(String(value || ''));
  return chars.length > max ? chars.slice(0, max).join('') + '…（続きは就活OS）' : chars.join('');
};
const calendarDate = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
export function googleCalendarURL(company, event) {
  const start = new Date(event.date);
  if (!Number.isFinite(start.getTime())) return '';
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(event.date);
  // 日付だけの進捗は終日、時刻付きの予定は終了を1時間後で仮置きする。
  const end = new Date(start.getTime() + (allDay ? 24 : 1) * 60 * 60 * 1000);
  const url = new URL('https://calendar.google.com/calendar/r/eventedit');
  url.search = new URLSearchParams({
    action: 'TEMPLATE',
    text: excerpt(`${company.name}｜${event.title}`, 180),
    dates: allDay
      ? `${event.date.replace(/-/g, '')}/${calendarDate(end).slice(0, 8)}`
      : `${calendarDate(start)}/${calendarDate(end)}`,
    details: [
      excerpt(event.notes, 600),
      allDay
        ? '就活OSの選考タイムラインから追加。終日で仮設定しています。必要に応じて時刻を指定してください。'
        : '就活OSから追加。終了時刻は仮で1時間後です。必要に応じて変更してください。',
    ]
      .filter(Boolean)
      .join('\n\n'),
  }).toString();
  return url.href;
}
