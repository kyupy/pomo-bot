const {
  ensureSession,
  formatRemaining,
  phaseLabel,
  getParticipantActiveMsNow,
} = require('./state');

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function btn(id, label, style) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

function buildComponents() {
  const row = new ActionRowBuilder().addComponents(
    btn('pomo:join', '参加', ButtonStyle.Secondary),
    btn('pomo:leave', '離脱', ButtonStyle.Secondary),
    btn('pomo:goal:now', '目標（今）', ButtonStyle.Primary),
    btn('pomo:result:prev', '結果（直前）', ButtonStyle.Success),
    btn('pomo:goal:pick', '目標（指定）', ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    btn('pomo:result:pick', '結果（指定）', ButtonStyle.Secondary),
  );
  return [row, row2];
}

function sliceLine(name, text) {
  const t = (text ?? '').trim();
  return t ? `${name}:${t}` : null;
}

function buildStockBlock(completedUpTo, K) {
  const s = ensureSession();
  if (completedUpTo < 1) return '—';

  const from = Math.max(1, completedUpTo - K + 1);
  const lines = [];
  for (let n = from; n <= completedUpTo; n++) {
    const slice = s.slices.get(n);
    if (!slice) continue;

    const goals = [];
    for (const [uid, text] of slice.goalByUser.entries()) {
      const name = s.participants.get(uid)?.name ?? uid;
      const l = sliceLine(name, text);
      if (l) goals.push(l);
    }

    const results = [];
    for (const [uid, text] of slice.resultByUser.entries()) {
      const name = s.participants.get(uid)?.name ?? uid;
      const l = sliceLine(name, text);
      if (l) results.push(l);
    }

    lines.push(
      `### 通し#${n}\n` +
      `🎯 ${goals.length ? goals.join(' / ') : '—'}\n` +
      `🧾 ${results.length ? results.join(' / ') : '—'}`
    );
  }
  return lines.length ? lines.join('\n\n') : '—';
}

function buildContent() {
  const s = ensureSession();

  const endAt = s.currentPhaseEndsAtMs;
  const remain = s.phase === 'paused'
    ? (s.currentPhaseRemainingMs ?? 0)
    : Math.max(0, (endAt ?? Date.now()) - Date.now());

  const endUnix = endAt ? Math.floor(endAt / 1000) : null;
  const endLine = endUnix ? `終了予定：<t:${endUnix}:t>` : `終了予定：—`;

  const activeNames = [];
  for (const [, p] of s.participants) {
    if (p.isActive) activeNames.push(p.name);
  }

  const top = Array.from(s.participants.values())
    .map(p => ({ name: p.name, ms: getParticipantActiveMsNow(p) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5);
  const topLine = top.length
    ? top.map(t => `${t.name}:${Math.floor(t.ms / 60000)}分`).join(' / ')
    : '—';

  // 完了スライス: focus中は現在スライス未完了→sliceSeq-1、休憩中はsliceSeqまで完了扱い
  const completedUpTo = (s.phase === 'focus') ? (s.sliceSeq - 1) : s.sliceSeq;
  const stock = buildStockBlock(completedUpTo, s.stockLimit ?? 4);

  return (
    `# 囚人作業会：${s.title}\n` +
    `**状態**：${phaseLabel(s.phase)}\n` +
    `**ポモ**：#${s.pomodoroIndex} / **スライス**：${s.sliceInPomodoro}/${s.slicesPerPomodoro} / **通し**：#${s.sliceSeq}\n` +
    `${endLine}\n` +
    `**残り（概算）**：${formatRemaining(remain)}\n` +
    `\n` +
    `## 参加中\n` +
    `${activeNames.length ? activeNames.join(' / ') : '—'}\n` +
    `\n` +
    `## 参加時間TOP5（概算）\n` +
    `${topLine}\n` +
    `\n` +
    `## ストック（完了スライス・直近）\n` +
    `${stock}\n` +
    `\n` +
    `（Flow＝ログはスレッドへ。Stock＝ここだけ）`
  );
}

async function getOrCreateTimerMessage(timerChannel) {
  const s = ensureSession();
  if (s.timerMessageId) {
    try {
      return await timerChannel.messages.fetch(s.timerMessageId);
    } catch (_) {}
  }
  const msg = await timerChannel.send('（タイマー準備中…）');
  s.timerMessageId = msg.id;
  return msg;
}

async function renderTimer(timerChannel) {
  const msg = await getOrCreateTimerMessage(timerChannel);
  await msg.edit({ content: buildContent(), components: buildComponents() }).catch(() => {});
}

module.exports = { renderTimer };
