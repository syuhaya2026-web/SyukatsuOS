// Driveで読むための企業別テキスト（同期の原本ではない）
export function companyNote(company, data) {
  const progress = data.progress
    .filter((x) => x.companyId === company.id)
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const events = data.events
    .filter((x) => x.companyId === company.id)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const files = new Map(data.files.map((x) => [x.id, x]));
  const current = progress.find((x) => x.id === company.currentStatusId)?.title || '未設定';
  const lines = [
    company.name,
    '='.repeat(32),
    '閲覧用の自動生成ファイルです。編集は就活OSから行ってください。',
    'このファイルをDriveで編集しても、アプリには反映されません。次回更新時に上書きされます。',
    '',
    `現在のステータス：${current}`,
    `My Page：${company.myPageUrl || '未登録'}`,
    `企業サイト：${company.companyUrl || '未登録'}`,
    '',
    '■ 企業メモ',
    company.notes || '（なし）',
    '',
    '■ 選考タイムライン',
  ];
  if (!progress.length) lines.push('（記録なし）');
  for (const p of progress) {
    lines.push('', `${p.date}  ${p.title}`, p.notes || '（メモなし）');
    if (p.attachmentIds.length) {
      lines.push('添付：');
      for (const id of p.attachmentIds) {
        const f = files.get(id);
        lines.push(
          `  ・${f?.name || id}${f ? ' (' + Math.ceil((f.size || 0) / 1024) + ' KB)' : ''}`,
        );
      }
    }
  }
  lines.push('', '■ 予定・イベント');
  if (!events.length) lines.push('（予定なし）');
  for (const e of events)
    lines.push('', `${e.date.replace('T', ' ')}  ${e.title}`, e.notes || '（メモなし）');
  lines.push(
    '',
    '---',
    `企業ID：${company.id}`,
    '添付本体と復元用データは、就活OSフォルダの履歴JSONに保存されています。',
    'このテキストだけではアプリ全体の復元はできません。',
  );
  return lines.join('\n') + '\n';
}
export const noteName = (company) =>
  `${company.name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 80) || '企業'}__${company.id}.txt`;
