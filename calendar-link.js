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
  // アプリは開始時刻のみを保持するため、終了は1時間後を仮置きする。
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const url = new URL('https://calendar.google.com/calendar/r/eventedit');
  url.search = new URLSearchParams({
    action: 'TEMPLATE',
    text: excerpt(`${company.name}｜${event.title}`, 180),
    dates: `${calendarDate(start)}/${calendarDate(end)}`,
    details: [
      excerpt(event.notes, 600),
      '就活OSから追加。終了時刻は仮で1時間後です。必要に応じて変更してください。',
    ]
      .filter(Boolean)
      .join('\n\n'),
  }).toString();
  return url.href;
}
