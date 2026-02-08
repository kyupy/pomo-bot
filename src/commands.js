const { ThreadAutoArchiveDuration } = require('discord.js');
const {
  mustEnv,
  jstDateString,
  safeName,
  getSession,
  setSession,
  isControlAllowed,
  clearAllTimers,
  fetchForumChannel,
  fetchTimerChannel,
  fetchThread,
  getNextIndexForPrefix,
  joinParticipant,
  leaveParticipant,
  finalizeAllParticipants,
  setGoal,
  setResult,
  formatRemaining,
  phaseLabel,
} = require('./state');

const { renderTimer } = require('./ui_timer');
const { logThread, postFinalSummary } = require('./ui_thread');
const { startFocus, pauseTimer, resumeTimer } = require('./timer');

function calcActiveMsNow(s) {
  const now = Date.now();
  const pausedExtra = s.pauseStartedAtMs ? (now - s.pauseStartedAtMs) : 0;
  return Math.max(0, (now - s.startedAtMs) - (s.pausedMsAccum + pausedExtra));
}

async function handleStart(interaction) {
  const existing = getSession();
  if (existing && existing.phase !== 'done') {
    return interaction.reply({ content: 'すでに進行中です。/pomo status', ephemeral: true });
  }

  mustEnv('FORUM_CHANNEL_ID');
  mustEnv('TIMER_CHANNEL_ID');
  mustEnv('DISCORD_TOKEN');

  const mode = interaction.options.getString('mode') ?? 'self';
  const sliceMin = interaction.options.getInteger('slice') ?? 32;
  const shortBreakMin = interaction.options.getInteger('short') ?? 5;
  const longBreakMin = interaction.options.getInteger('long') ?? 14;
  const slicesPerPomodoro = interaction.options.getInteger('slices') ?? 3;

  const dateStr = jstDateString();
  const basePrefix = `${mode}-${dateStr}`;
  const forum = await fetchForumChannel(interaction.guild);
  const idx = await getNextIndexForPrefix(forum, basePrefix);
  const title = `${basePrefix}-${idx}`;

  const thread = await forum.threads.create({
    name: title,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    message: {
      content:
        `**${title}**\n` +
        `slice ${sliceMin} / short ${shortBreakMin} / long ${longBreakMin} / slices ${slicesPerPomodoro}\n` +
        `タイマー＆操作：<#${mustEnv('TIMER_CHANNEL_ID')}>\n` +
        `（止めるまで無限ループ。/pomo pause / /pomo resume / /pomo stop）`,
    },
  });

  setSession({
    title,
    mode,
    dateStr,

    threadId: thread.id,
    forumId: forum.id,
    timerChannelId: mustEnv('TIMER_CHANNEL_ID'),
    timerMessageId: null,

    sliceMin,
    shortBreakMin,
    longBreakMin,
    slicesPerPomodoro,

    phase: 'idle',
    pomodoroIndex: 1,
    sliceInPomodoro: 1,
    sliceSeq: 0,

    hostId: interaction.user.id,

    participants: new Map(),
    slices: new Map(), // THE TRUTH

    // timers
    timeouts: [],
    intervals: [],

    startedAtMs: Date.now(),
    pausedMsAccum: 0,
    pauseStartedAtMs: null,
    pausedFrom: null,

    currentPhaseEndsAtMs: null,
    currentPhaseRemainingMs: null,

    stockLimit: 4, // 直近K件
  });

  const timerChannel = await fetchTimerChannel(interaction.guild);
  await renderTimer(timerChannel);

  await interaction.reply({
    content: `開始しました：${thread.toString()}（${title}）\nタイマー＆操作：<#${timerChannel.id}>`,
    ephemeral: true,
  });

  await logThread(thread, '# 囚人作業会開始');
  await logThread(thread, `## ポモ#1 開始`);
  await startFocus(thread, timerChannel, { resume: false });
}

async function handleStop(interaction) {
  const s = getSession();
  if (!s || s.phase === 'done') {
    return interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
  }
  if (!isControlAllowed(interaction)) {
    return interaction.reply({ content: '停止できるのは作成者/管理者だけです。', ephemeral: true });
  }

  clearAllTimers();
  finalizeAllParticipants();
  s.phase = 'done';

  const thread = await fetchThread(interaction.guild);
  const timerChannel = await fetchTimerChannel(interaction.guild).catch(() => null);

  await logThread(thread, '🛑 セッションを停止しました。');
  await postFinalSummary(thread);
  if (timerChannel) await renderTimer(timerChannel);

  return interaction.reply({ content: '停止しました。', ephemeral: true });
}

async function handlePause(interaction) {
  const s = getSession();
  if (!s || s.phase === 'done') {
    return interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
  }
  if (!isControlAllowed(interaction)) {
    return interaction.reply({ content: '一時停止できるのは作成者/管理者だけです。', ephemeral: true });
  }
  if (s.phase === 'paused') {
    return interaction.reply({ content: 'すでに一時停止中です。', ephemeral: true });
  }

  const thread = await fetchThread(interaction.guild);
  const timerChannel = await fetchTimerChannel(interaction.guild);
  await pauseTimer(thread, timerChannel);

  return interaction.reply({ content: '一時停止しました。', ephemeral: true });
}

async function handleResume(interaction) {
  const s = getSession();
  if (!s || s.phase === 'done') {
    return interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
  }
  if (s.phase !== 'paused') {
    return interaction.reply({ content: '一時停止中ではありません。', ephemeral: true });
  }
  if (!isControlAllowed(interaction)) {
    return interaction.reply({ content: '再開できるのは作成者/管理者だけです。', ephemeral: true });
  }

  const thread = await fetchThread(interaction.guild);
  const timerChannel = await fetchTimerChannel(interaction.guild);
  await resumeTimer(thread, timerChannel);

  return interaction.reply({ content: '再開しました。', ephemeral: true });
}

async function handleStatus(interaction) {
  const s = getSession();
  if (!s) return interaction.reply({ content: 'セッション情報がありません。', ephemeral: true });

  const thread = await fetchThread(interaction.guild);

  const remain = s.phase === 'paused'
    ? s.currentPhaseRemainingMs
    : Math.max(0, (s.currentPhaseEndsAtMs ?? Date.now()) - Date.now());

  const activeMs = calcActiveMsNow(s);

  return interaction.reply({
    content:
      `現在：${thread ? thread.toString() : s.threadId}\n` +
      `状態：${phaseLabel(s.phase)}\n` +
      `ポモ#${s.pomodoroIndex} / スライス${s.sliceInPomodoro}/${s.slicesPerPomodoro} / 通し#${s.sliceSeq}\n` +
      `残り（概算）：${formatRemaining(remain ?? 0)}\n` +
      `累計：${Math.floor(activeMs / 60000)}分（停止時間除く）`,
    ephemeral: true,
  });
}

async function handleJoin(interaction) {
  const s = getSession();
  if (!s) return interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });

  joinParticipant(interaction.user.id, safeName(interaction));

  const thread = await fetchThread(interaction.guild);
  await logThread(thread, `➕ ${safeName(interaction)}：参加`);

  const timerChannel = await fetchTimerChannel(interaction.guild);
  await renderTimer(timerChannel);

  return interaction.reply({ content: '参加しました。', ephemeral: true });
}

async function handleLeave(interaction) {
  const s = getSession();
  if (!s) return interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });

  leaveParticipant(interaction.user.id, safeName(interaction));

  const thread = await fetchThread(interaction.guild);
  await logThread(thread, `➖ ${safeName(interaction)}：離脱`);

  const timerChannel = await fetchTimerChannel(interaction.guild);
  await renderTimer(timerChannel);

  return interaction.reply({ content: '離脱しました。', ephemeral: true });
}

async function handleEditGoal(interaction) {
  const s = getSession();
  if (!s) return interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });

  const slice = interaction.options.getInteger('slice', true);
  if (slice < 1 || slice > Math.max(1, s.sliceSeq + 1)) {
    return interaction.reply({ content: `slice は 1..${Math.max(1, s.sliceSeq + 1)} の範囲で指定してください。`, ephemeral: true });
  }
  const text = interaction.options.getString('text', true);
  setGoal(slice, interaction.user.id, text);

  const thread = await fetchThread(interaction.guild);
  await logThread(thread, `✏️ 🎯 ${safeName(interaction)}：目標を編集（#${slice}）`);

  const timerChannel = await fetchTimerChannel(interaction.guild);
  await renderTimer(timerChannel);

  return interaction.reply({ content: `目標を更新しました（#${slice}）。`, ephemeral: true });
}

async function handleEditResult(interaction) {
  const s = getSession();
  if (!s) return interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });

  const slice = interaction.options.getInteger('slice', true);
  if (slice < 1 || slice > Math.max(1, s.sliceSeq)) {
    return interaction.reply({ content: `slice は 1..${Math.max(1, s.sliceSeq)} の範囲で指定してください。`, ephemeral: true });
  }
  const text = interaction.options.getString('text', true);
  setResult(slice, interaction.user.id, text);

  const thread = await fetchThread(interaction.guild);
  await logThread(thread, `✏️ 🧾 ${safeName(interaction)}：結果を編集（#${slice}）`);

  const timerChannel = await fetchTimerChannel(interaction.guild);
  await renderTimer(timerChannel);

  return interaction.reply({ content: `結果を更新しました（#${slice}）。`, ephemeral: true });
}

module.exports = {
  handleStart,
  handleStop,
  handlePause,
  handleResume,
  handleStatus,
  handleJoin,
  handleLeave,
  handleEditGoal,
  handleEditResult,
};
