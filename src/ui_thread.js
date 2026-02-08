const { ensureSession, formatMinutes, getParticipantActiveMsNow } = require('./state');

async function logThread(thread, content) {
  if (!thread) return;
  await thread.send({ content }).catch(() => {});
}

function finalSummaryText() {
  const s = ensureSession();
  const ranking = Array.from(s.participants.values())
    .map(p => ({ name: p.name, ms: getParticipantActiveMsNow(p) }))
    .sort((a, b) => b.ms - a.ms);

  const rankLines = ranking.length
    ? ranking.map((r, i) => `${i + 1}. ${r.name}：${formatMinutes(r.ms)}`).join('\n')
    : '—';

  return (
    `# ✅ 最終サマリー\n` +
    `タイトル：${s.title}\n` +
    `通しスライス：${s.sliceSeq}\n` +
    `\n## 参加時間ランキング\n${rankLines}\n` +
    `\n（サマリーの蓄積はタイマーチャンネルのストックを参照）`
  );
}

async function postFinalSummary(thread) {
  if (!thread) return;
  await thread.send({ content: finalSummaryText() }).catch(() => {});
}

module.exports = { logThread, postFinalSummary };
