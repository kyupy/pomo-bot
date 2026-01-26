require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  ChannelType,
  ThreadAutoArchiveDuration,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  Events,
} = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ======= グローバル（同時セッションなし）状態 =======
let session = null;
/**
session = {
  threadId, forumId, mode, dateStr, title,
  sliceMin, shortBreakMin, longBreakMin, slicesPerPomodoro,
  phase: 'idle'|'focus'|'shortBreak'|'longBreak'|'paused'|'done',
  pomodoroIndex, sliceInPomodoro, sliceSeq,
  hostId,

  participants: Map<userId, { goals: [], results: [], goalMsgIds: [], resultMsgIds: [] }>,

  timeouts: [], intervals: [],
  startedAtMs,
  pausedMsAccum,
  pauseStartedAtMs,

  currentPhaseEndsAtMs,
  currentPhaseRemainingMs,
  currentPhaseMessageId,

  pausedFrom,
  currentPhaseTitleLine,
  currentPhaseHeaderLines,

  sliceMeta: {},        // { [sliceSeq]: { pomodoro, sliceInPomodoro } }
  pomodoroSlices: {},   // { [pomodoroIndex]: [sliceSeq, ...] }

  editWindowUntilMs: 0, // 終了後に編集を許す期限

  // ===== サマリーを編集で更新するためのID群 =====
  pomodoroSummaryMsgIds: {}, // { [pomodoroIndex]: [messageId, messageId, ...] }
  finalSummaryMsgIds: [],    // [messageId, ...]
}
*/

function jstDateString() {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function safeName(interaction) {
  return interaction.member?.displayName || interaction.user.username;
}

function isControlAllowed(interaction) {
  const owner = process.env.OWNER_USER_ID;
  if (owner && interaction.user.id === owner) return true;
  if (session?.hostId && interaction.user.id === session.hostId) return true;
  const member = interaction.member;
  return member?.permissions?.has(PermissionFlagsBits.Administrator);
}

function clearAllTimers() {
  if (!session) return;
  for (const t of session.timeouts) clearTimeout(t);
  for (const i of session.intervals) clearInterval(i);
  session.timeouts = [];
  session.intervals = [];
}

function ensureParticipant(userId) {
  if (!session.participants.has(userId)) {
    session.participants.set(userId, {
      goals: [],
      results: [],
      goalMsgIds: [],
      resultMsgIds: [],
    });
  }
  return session.participants.get(userId);
}

async function fetchForumChannel(guild) {
  const forumId = process.env.FORUM_CHANNEL_ID;
  const ch = await guild.channels.fetch(forumId);
  if (!ch) throw new Error('FORUM_CHANNEL_ID: channel not found');
  if (ch.type !== ChannelType.GuildForum) throw new Error('FORUM_CHANNEL_ID is not a forum channel');
  return ch;
}

async function postThreadMessage(thread, content, components) {
  const payload = { content };
  if (components) payload.components = [components];
  return thread.send(payload);
}

async function getNextIndexForPrefix(forumChannel, basePrefix) {
  const re = new RegExp(`^${basePrefix}-(\\d+)$`);
  let max = 0;

  const active = await forumChannel.threads.fetchActive();
  for (const [, th] of active.threads) {
    const m = th.name.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }

  const archived = await forumChannel.threads.fetchArchived({ limit: 100 });
  for (const [, th] of archived.threads) {
    const m = th.name.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }

  return max + 1;
}

// ======= Buttons =======
function goalButton(sliceSeq) {
  return new ButtonBuilder()
    .setCustomId(`pomo:goal:${sliceSeq}`)
    .setLabel(`目標入力（スライス#${sliceSeq}）`)
    .setStyle(ButtonStyle.Primary);
}

function resultButton(sliceSeq) {
  return new ButtonBuilder()
    .setCustomId(`pomo:result:${sliceSeq}`)
    .setLabel(`結果入力（スライス#${sliceSeq}）`)
    .setStyle(ButtonStyle.Success);
}

function buildGoalOnlyRow(sliceSeq) {
  return new ActionRowBuilder().addComponents(goalButton(sliceSeq));
}

function buildResultOnlyRow(sliceSeq) {
  return new ActionRowBuilder().addComponents(resultButton(sliceSeq));
}

function buildBreakRow({ prevSliceSeq, nextSliceSeq, includeNextGoal }) {
  const row = new ActionRowBuilder();
  if (includeNextGoal && nextSliceSeq) row.addComponents(goalButton(nextSliceSeq));
  if (prevSliceSeq) row.addComponents(resultButton(prevSliceSeq));
  return row;
}

function formatHHMMSS(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}時間${m}分${s}秒`;
}

function formatRemaining(ms) {
  const mins = Math.max(0, Math.ceil(ms / 60000));
  return `${mins}分`;
}

// ======= countdown message fetch/create =======
async function getOrCreateCountdownMessage(thread, components) {
  if (session.currentPhaseMessageId) {
    try {
      const msg = await thread.messages.fetch(session.currentPhaseMessageId);
      return msg;
    } catch (_) {}
  }

  const msg = await thread.send({
    content: '（タイマー準備中…）',
    components: components ? [components] : [],
  });
  session.currentPhaseMessageId = msg.id;
  return msg;
}

// ======= 1分ごとの編集タイマー =======
async function startEditableCountdown({
  thread,
  titleLine,
  durationMs,
  headerLines = [],
  components = null,
  reuseExistingMessage = false,
}) {
  const endAt = Date.now() + durationMs;
  session.currentPhaseEndsAtMs = endAt;

  // pause表示やresume再開時に使うため保存
  session.currentPhaseTitleLine = titleLine;
  session.currentPhaseHeaderLines = headerLines;

  const contentOf = () => {
    const remain = endAt - Date.now();
    const endUnix = Math.floor(endAt / 1000);
    const head = headerLines.length ? headerLines.join('\n') + '\n' : '';
    return (
      `${head}` +
      `${titleLine}\n` +
      `終了予定：<t:${endUnix}:t>\n` +
      `残り：${formatRemaining(remain)}`
    );
  };

  let msg;
  if (reuseExistingMessage) {
    msg = await getOrCreateCountdownMessage(thread, components);
    await msg.edit({
      content: contentOf(),
      components: components ? [components] : [],
    });
  } else {
    msg = await thread.send({
      content: contentOf(),
      components: components ? [components] : [],
    });
    session.currentPhaseMessageId = msg.id;
  }

  // ★毎分編集でも components を維持（ボタンが消える事故対策）
  const interval = setInterval(async () => {
    try {
      await msg.edit({
        content: contentOf(),
        components: components ? [components] : [],
      });
    } catch (_) {}
  }, 60 * 1000);
  session.intervals.push(interval);

  // ★終了瞬間に最終表示へ（残り1分で止まって見える問題の解消）
  const cleanup = setTimeout(async () => {
    try {
      const head = headerLines.length ? headerLines.join('\n') + '\n' : '';
      await msg.edit({
        content: `${head}${titleLine}\n✅ 終了しました\n残り：0分`,
        components: components ? [components] : [],
      });
    } catch (_) {}
    clearInterval(interval);
  }, durationMs);
  session.timeouts.push(cleanup);

  return { msg, endAt };
}

async function renderPausedOnCountdownMessage(thread) {
  if (!session.currentPhaseMessageId) return;
  let msg;
  try {
    msg = await thread.messages.fetch(session.currentPhaseMessageId);
  } catch (_) {
    return;
  }

  const remain = session.currentPhaseRemainingMs ?? 0;
  const head = session.currentPhaseHeaderLines?.length ? session.currentPhaseHeaderLines.join('\n') + '\n' : '';
  const title = session.currentPhaseTitleLine ?? '**（フェーズ不明）**';

  const content =
    `${head}` +
    `${title}\n` +
    `⏸️ **一時停止中**\n` +
    `残り：${formatRemaining(remain)}\n` +
    `再開：/pomo resume`;

  try {
    await msg.edit({ content });
  } catch (_) {}
}

// ======= Summary utilities（2000文字制限対策） =======
const DISCORD_SAFE_LEN = 1900;

function chunkLinesToMessages(lines, maxLen = DISCORD_SAFE_LEN) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const add = (cur.length === 0) ? line : `\n${line}`;
    if ((cur.length + add.length) > maxLen) {
      if (cur.length > 0) chunks.push(cur);
      cur = line;
    } else {
      cur += add;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  if (chunks.length === 0) chunks.push('（空）');
  return chunks;
}

async function upsertMessageParts(thread, idsArr, contentsArr) {
  // idsArr: session上の参照（配列）
  // contentsArr: 送るべき内容（配列）
  for (let i = 0; i < contentsArr.length; i++) {
    const content = contentsArr[i] || '（空）';
    const msgId = idsArr[i];

    if (msgId) {
      try {
        const msg = await thread.messages.fetch(msgId);
        await msg.edit(content);
        continue;
      } catch (_) {
        // fetch失敗 → 送り直し
      }
    }

    const sent = await thread.send(content);
    idsArr[i] = sent.id;
  }

  // 余った古いパーツは「空です」にする（削除は権限問題が出ることがあるため）
  for (let i = contentsArr.length; i < idsArr.length; i++) {
    const msgId = idsArr[i];
    if (!msgId) continue;
    try {
      const msg = await thread.messages.fetch(msgId);
      await msg.edit('（このサマリーは短くなったため空です）');
    } catch (_) {}
  }

  // idsArrの後ろを詰める
  idsArr.length = Math.max(idsArr.length, contentsArr.length);
}

function quoteBlock(text) {
  const body = (text && text.trim()) ? text.trim() : '（未入力）';
  return body.split('\n').map(l => `> ${l}`).join('\n');
}

function renderPomodoroSummaryLines(pomodoroIndex) {
  const sliceSeqs = session.pomodoroSlices[pomodoroIndex] || [];
  const lines = [];
  lines.push('---');
  lines.push(`## ポモ#${pomodoroIndex} サマリー`);

  if (sliceSeqs.length === 0) {
    lines.push('（このポモにはまだスライスがありません）');
    return lines;
  }

  for (const [userId, data] of session.participants.entries()) {
    lines.push(`### <@${userId}>`);
    for (const seq of sliceSeqs) {
      const meta = session.sliceMeta[seq];
      const g = data.goals[seq - 1] ?? '';
      const r = data.results[seq - 1] ?? '';
      lines.push(`**スライス${meta?.sliceInPomodoro ?? '?'}（通し#${seq}）**`);
      lines.push(`目標：`);
      lines.push(quoteBlock(g));
      lines.push(`結果：`);
      lines.push(quoteBlock(r));
      lines.push('');
    }
  }
  return lines;
}

function renderFinalSummaryLines() {
  const pomos = Object.keys(session.pomodoroSlices || {})
    .map(n => Number(n))
    .sort((a, b) => a - b);

  const lines = [];
  lines.push('---');
  lines.push('# 最終サマリー');
  lines.push(`完了スライス数：**${session.sliceSeq}**`);
  lines.push('');

  if (pomos.length === 0) {
    lines.push('（まだスライスがありません）');
    return lines;
  }

  for (const p of pomos) {
    lines.push(`## ポモ#${p}`);
    const sliceSeqs = session.pomodoroSlices[p] || [];
    if (sliceSeqs.length === 0) {
      lines.push('（なし）');
      lines.push('');
      continue;
    }

    for (const [userId, data] of session.participants.entries()) {
      lines.push(`### <@${userId}>`);
      for (const seq of sliceSeqs) {
        const meta = session.sliceMeta[seq];
        const g = data.goals[seq - 1] ?? '';
        const r = data.results[seq - 1] ?? '';
        lines.push(`**スライス${meta?.sliceInPomodoro ?? '?'}（通し#${seq}）**`);
        lines.push(`目標：`);
        lines.push(quoteBlock(g));
        lines.push(`結果：`);
        lines.push(quoteBlock(r));
        lines.push('');
      }
    }
  }

  return lines;
}

async function ensurePomodoroSummaryPosted(thread, pomodoroIndex) {
  if (!session.pomodoroSummaryMsgIds[pomodoroIndex]) {
    session.pomodoroSummaryMsgIds[pomodoroIndex] = [];
    // まずはプレースホルダを1通送ってID確保（編集更新のため）
    const msg = await thread.send(`---\n## ポモ#${pomodoroIndex} サマリー（準備中）`);
    session.pomodoroSummaryMsgIds[pomodoroIndex].push(msg.id);
  }
  await updatePomodoroSummary(thread, pomodoroIndex);
}

async function updatePomodoroSummary(thread, pomodoroIndex) {
  if (!session.pomodoroSummaryMsgIds[pomodoroIndex]) return; // まだ投稿してないなら何もしない
  const lines = renderPomodoroSummaryLines(pomodoroIndex);
  const contents = chunkLinesToMessages(lines);
  const idsArr = session.pomodoroSummaryMsgIds[pomodoroIndex];
  await upsertMessageParts(thread, idsArr, contents);
}

async function ensureFinalSummaryPosted(thread) {
  if (!session.finalSummaryMsgIds || session.finalSummaryMsgIds.length === 0) {
    session.finalSummaryMsgIds = [];
    const msg = await thread.send('---\n# 最終サマリー（準備中）');
    session.finalSummaryMsgIds.push(msg.id);
  }
  await updateFinalSummary(thread);
}

async function updateFinalSummary(thread) {
  if (!session.finalSummaryMsgIds) session.finalSummaryMsgIds = [];
  if (session.finalSummaryMsgIds.length === 0) {
    const msg = await thread.send('---\n# 最終サマリー（準備中）');
    session.finalSummaryMsgIds.push(msg.id);
  }
  const lines = renderFinalSummaryLines();
  const contents = chunkLinesToMessages(lines);
  await upsertMessageParts(thread, session.finalSummaryMsgIds, contents);
}

async function updateAllSummaries(thread) {
  // 各ポモサマリー（存在するものだけ）更新
  const pomos = Object.keys(session.pomodoroSummaryMsgIds || {})
    .map(n => Number(n))
    .sort((a, b) => a - b);

  for (const p of pomos) {
    await updatePomodoroSummary(thread, p);
  }

  // ★最終サマリーは「存在するときだけ」更新
  if (session.finalSummaryMsgIds && session.finalSummaryMsgIds.length > 0) {
    await updateFinalSummary(thread);
  }
}


async function announcePomodoroEnd(thread) {
  await postThreadMessage(thread, `## ポモ#${session.pomodoroIndex} 終了`);
}

async function startFocus(thread, { resume = false } = {}) {
  session.phase = 'focus';

  if (!resume) {
    session.sliceSeq += 1;
    const sliceSeq = session.sliceSeq;

    // メタ記録（start時点が確定値）
    session.sliceMeta[sliceSeq] = { pomodoro: session.pomodoroIndex, sliceInPomodoro: session.sliceInPomodoro };
    if (!session.pomodoroSlices[session.pomodoroIndex]) session.pomodoroSlices[session.pomodoroIndex] = [];
    if (!session.pomodoroSlices[session.pomodoroIndex].includes(sliceSeq)) {
      session.pomodoroSlices[session.pomodoroIndex].push(sliceSeq);
    }

    const p = session.pomodoroIndex;
    const s = session.sliceInPomodoro;

    await postThreadMessage(thread, `### ポモ#${p} スライス${s} 開始（通しスライス#${sliceSeq}）`);

    // 例外：最初のスライスだけ目標ボタン
    if (sliceSeq === 1) {
      await postThreadMessage(thread, `このスライスの目標を書くならここ（任意）：`, buildGoalOnlyRow(sliceSeq));
    }
  } else {
    await postThreadMessage(
      thread,
      `▶️ 再開：ポモ#${session.pomodoroIndex} スライス${session.sliceInPomodoro}（通し#${session.sliceSeq}）`
    );
  }

  const sliceSeq = session.sliceSeq;
  const durationMs = session.currentPhaseRemainingMs ?? (session.sliceMin * 60 * 1000);
  session.currentPhaseRemainingMs = null;

  // ★集中開始ごとに新規メッセージ（resumeだけreuse）
  await startEditableCountdown({
    thread,
    titleLine: `**集中**（${session.sliceMin}分）`,
    durationMs,
    headerLines: [
      `囚人作業会：ポモ#${session.pomodoroIndex} / スライス${session.sliceInPomodoro}/${session.slicesPerPomodoro}（通し#${sliceSeq}）`,
    ],
    components: null,
    reuseExistingMessage: resume,
  });

  session.timeouts.push(setTimeout(async () => {
    await onFocusEnd(thread, sliceSeq);
  }, durationMs));
}

async function onFocusEnd(thread, sliceSeq) {
  await postThreadMessage(
    thread,
    `### ポモ#${session.pomodoroIndex} スライス${session.sliceInPomodoro} 終了（通しスライス#${sliceSeq}）`
  );

  const isLast = session.sliceInPomodoro >= session.slicesPerPomodoro;

  // 長休憩に入った瞬間にポモ終了＋そのポモのサマリーを「投稿＆ID保持」
  if (isLast) {
    await announcePomodoroEnd(thread);
    await ensurePomodoroSummaryPosted(thread, session.pomodoroIndex);
  }

  session.phase = isLast ? 'longBreak' : 'shortBreak';

  const breakMin = isLast ? session.longBreakMin : session.shortBreakMin;
  const durationMs = session.currentPhaseRemainingMs ?? (breakMin * 60 * 1000);
  session.currentPhaseRemainingMs = null;

  const nextSliceSeq = session.sliceSeq + 1;
  const includeNextGoal = true;

  // ★休憩開始ごとに新規メッセージ（resumeだけreuse）
  await startEditableCountdown({
    thread,
    titleLine: isLast ? `**長休憩**（${breakMin}分）` : `**休憩**（${breakMin}分）`,
    durationMs,
    headerLines: [
      `囚人作業会：ポモ#${session.pomodoroIndex} / スライス${session.sliceInPomodoro}/${session.slicesPerPomodoro}（通し#${sliceSeq}）`,
      `この休憩中に：次の目標（#${nextSliceSeq}）と、直前の結果（#${sliceSeq}）をどうぞ`,
    ],
    components: buildBreakRow({ prevSliceSeq: sliceSeq, nextSliceSeq, includeNextGoal }),
    reuseExistingMessage: false,
  });

  session.timeouts.push(setTimeout(async () => {
    await onBreakEnd(thread, isLast);
  }, durationMs));
}

async function resumeBreak(thread) {
  const sliceSeq = session.sliceSeq;
  const wasLongBreak = session.pausedFrom === 'longBreak';
  const breakMin = wasLongBreak ? session.longBreakMin : session.shortBreakMin;

  session.phase = wasLongBreak ? 'longBreak' : 'shortBreak';

  const durationMs = session.currentPhaseRemainingMs ?? (breakMin * 60 * 1000);
  session.currentPhaseRemainingMs = null;

  const nextSliceSeq = session.sliceSeq + 1;

  await postThreadMessage(thread, `▶️ 再開：休憩（通し#${sliceSeq}）`);

  await startEditableCountdown({
    thread,
    titleLine: wasLongBreak ? `**長休憩**（${breakMin}分）` : `**休憩**（${breakMin}分）`,
    durationMs,
    headerLines: [
      `囚人作業会：ポモ#${session.pomodoroIndex} / スライス${session.sliceInPomodoro}/${session.slicesPerPomodoro}（通し#${sliceSeq}）`,
      `この休憩中に：次の目標（#${nextSliceSeq}）と、直前の結果（#${sliceSeq}）をどうぞ`,
    ],
    components: buildBreakRow({ prevSliceSeq: sliceSeq, nextSliceSeq, includeNextGoal: true }),
    reuseExistingMessage: true,
  });

  session.timeouts.push(setTimeout(async () => {
    await onBreakEnd(thread, wasLongBreak);
  }, durationMs));
}

async function onBreakEnd(thread, wasLongBreak) {
  if (wasLongBreak) {
    session.pomodoroIndex += 1;
    session.sliceInPomodoro = 1;

    await postThreadMessage(thread, `## ポモ#${session.pomodoroIndex} 開始`);
    await startFocus(thread, { resume: false });
    return;
  }

  session.sliceInPomodoro += 1;
  await startFocus(thread, { resume: false });
}

// ======= stop / status =======
function computeActiveMsNow() {
  const now = Date.now();
  const paused = session.pauseStartedAtMs ? (now - session.pauseStartedAtMs) : 0;
  return (now - session.startedAtMs) - session.pausedMsAccum - paused;
}

async function finalizeSession(thread, stoppedByText) {
  session.phase = 'done';
  session.editWindowUntilMs = Date.now() + 30 * 60 * 1000;

  const pomosDone = session.pomodoroIndex - 1;
  const slicesDone = session.sliceSeq;
  const activeMs = computeActiveMsNow();

  const components = (session.sliceSeq >= 1) ? buildResultOnlyRow(session.sliceSeq) : null;

  await postThreadMessage(
    thread,
    `# 囚人作業会終了\n` +
      `${stoppedByText}\n` +
      `完了：**${pomosDone}ポモ / ${slicesDone}スライス**\n` +
      `合計作業時間（停止時間除く）：**${formatHHMMSS(activeMs)}**\n` +
      (components ? `\n最後のスライス結果を編集するなら下のボタン：` : ''),
    components
  );

  await ensureFinalSummaryPosted(thread);
  // すでに投稿済みのポモサマリーがあれば全部更新、最終も更新（ID保持）
  await updateAllSummaries(thread);

  // 30分後にアーカイブ（編集猶予と一致）
  session.timeouts.push(setTimeout(async () => {
    try { await thread.setArchived(true); } catch (_) {}
  }, 30 * 60 * 1000));
}

async function handlePause(interaction) {
  if (!session || session.phase === 'done') {
    await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
    return;
  }
  if (!isControlAllowed(interaction)) {
    await interaction.reply({ content: '一時停止できるのは作成者/管理者だけです。', ephemeral: true });
    return;
  }
  if (session.phase === 'paused') {
    await interaction.reply({ content: 'すでに一時停止中です。', ephemeral: true });
    return;
  }

  const remain = Math.max(0, session.currentPhaseEndsAtMs - Date.now());
  session.currentPhaseRemainingMs = remain;

  clearAllTimers();

  session.pauseStartedAtMs = Date.now();
  session.phase = 'paused';

  const thread = await interaction.guild.channels.fetch(session.threadId);

  if (thread) {
    await renderPausedOnCountdownMessage(thread);
    await thread.send('⏸️ 一時停止しました。/pomo resume で再開できます。');
  }

  await interaction.reply({ content: '一時停止しました。', ephemeral: true });
}

async function handleResume(interaction) {
  if (!session || session.phase === 'done') {
    await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
    return;
  }
  if (!isControlAllowed(interaction)) {
    await interaction.reply({ content: '再開できるのは作成者/管理者だけです。', ephemeral: true });
    return;
  }
  if (session.phase !== 'paused') {
    await interaction.reply({ content: '一時停止中ではありません。', ephemeral: true });
    return;
  }

  const pausedFor = Date.now() - session.pauseStartedAtMs;
  session.pausedMsAccum += pausedFor;
  session.pauseStartedAtMs = null;

  const thread = await interaction.guild.channels.fetch(session.threadId);
  if (!thread) {
    await interaction.reply({ content: 'スレッドが見つかりません。', ephemeral: true });
    return;
  }

  await thread.send('▶️ 再開します。');
  await interaction.reply({ content: '再開しました。', ephemeral: true });

  const from = session.pausedFrom;

  if (from === 'focus') return await startFocus(thread, { resume: true });
  if (from === 'shortBreak' || from === 'longBreak') return await resumeBreak(thread);

  session.pausedFrom = 'focus';
  return await startFocus(thread, { resume: true });
}

// ======= Interaction handlers =======
async function handlePomoStart(interaction) {
  if (session && session.phase !== 'done') {
    await interaction.reply({ content: 'すでに囚人作業会が進行中です。/pomo status を確認してください。', ephemeral: true });
    return;
  }

  const mode = interaction.options.getString('mode', true);

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
        `（止めるまで無限ループ。/pomo pause / /pomo resume / /pomo stop）`,
    },
  });

  session = {
    threadId: thread.id,
    forumId: forum.id,
    mode,
    dateStr,
    title,
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
    timeouts: [],
    intervals: [],
    startedAtMs: Date.now(),
    pausedMsAccum: 0,
    pauseStartedAtMs: null,
    currentPhaseEndsAtMs: null,
    currentPhaseRemainingMs: null,
    currentPhaseMessageId: null,
    pausedFrom: null,
    currentPhaseTitleLine: null,
    currentPhaseHeaderLines: null,
    sliceMeta: {},
    pomodoroSlices: {},
    editWindowUntilMs: 0,

    pomodoroSummaryMsgIds: {},
    finalSummaryMsgIds: [],
  };

  await interaction.reply({
    content: `開始しました：${thread.toString()} （タイトル: ${title}）`,
    ephemeral: true,
  });

  await thread.send('# 囚人作業会開始');
  await postThreadMessage(thread, `## ポモ#${session.pomodoroIndex} 開始`);

  await startFocus(thread, { resume: false });
}

async function handlePomoStop(interaction) {
  if (!session || session.phase === 'done') {
    await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
    return;
  }
  if (!isControlAllowed(interaction)) {
    await interaction.reply({ content: '停止できるのは作成者/管理者（または OWNER_USER_ID）だけです。', ephemeral: true });
    return;
  }

  // ★先にACK（3秒制限対策）
  await interaction.deferReply({ ephemeral: true });

  if (session.pauseStartedAtMs) {
    session.pausedMsAccum += (Date.now() - session.pauseStartedAtMs);
    session.pauseStartedAtMs = null;
  }

  clearAllTimers();

  const thread = await interaction.guild.channels.fetch(session.threadId);
  if (thread) {
    await finalizeSession(thread, `停止者：${safeName(interaction)}`);
  }

  await interaction.editReply({ content: '停止しました。' });
}

async function handlePomoStatus(interaction) {
  if (!session || session.phase === 'done') {
    await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
    return;
  }
  const thread = await interaction.guild.channels.fetch(session.threadId);

  const activeMs = computeActiveMsNow();
  const remain = session.phase === 'paused'
    ? session.currentPhaseRemainingMs
    : Math.max(0, (session.currentPhaseEndsAtMs ?? Date.now()) - Date.now());

  await interaction.reply({
    content:
      `現在：${thread ? thread.toString() : session.threadId}\n` +
      `状態：${session.phase}\n` +
      `ポモ#${session.pomodoroIndex} / スライス${session.sliceInPomodoro}/${session.slicesPerPomodoro} / 通しスライス#${session.sliceSeq}\n` +
      `残り（概算）：${remain != null ? formatRemaining(remain) : '不明'}\n` +
      `累計：${formatHHMMSS(activeMs)}（停止時間除く）`,
    ephemeral: true,
  });
}

// ======= Modal UI =======
async function openGoalModal(interaction, sliceSeq) {
  const modal = new ModalBuilder()
    .setCustomId(`pomo:goalModal:${sliceSeq}`)
    .setTitle(`目標入力（スライス#${sliceSeq}）`);

  const input = new TextInputBuilder()
    .setCustomId('goalText')
    .setLabel('このスライスでやること（任意）')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function openResultModal(interaction, sliceSeq) {
  const modal = new ModalBuilder()
    .setCustomId(`pomo:resultModal:${sliceSeq}`)
    .setTitle(`結果入力（スライス#${sliceSeq}）`);

  const input = new TextInputBuilder()
    .setCustomId('resultText')
    .setLabel('このスライスでやったこと（任意）')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

// ======= Interaction router =======
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'pomo') return;
      const sub = interaction.options.getSubcommand();

      if (sub === 'start') return await handlePomoStart(interaction);

      if (sub === 'pause') {
        if (!session || session.phase === 'done') return interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
        if (!isControlAllowed(interaction)) return interaction.reply({ content: '一時停止できるのは作成者/管理者だけです。', ephemeral: true });
        if (session.phase === 'paused') return interaction.reply({ content: 'すでに一時停止中です。', ephemeral: true });

        session.pausedFrom = session.phase;
        return await handlePause(interaction);
      }

      if (sub === 'resume') return await handleResume(interaction);
      if (sub === 'stop') return await handlePomoStop(interaction);
      if (sub === 'status') return await handlePomoStatus(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (!session) {
        await interaction.reply({ content: 'セッション情報がありません。', ephemeral: true });
        return;
      }

      if (session.phase === 'done') {
        const ok = Date.now() < (session.editWindowUntilMs || 0);
        if (!ok) {
          await interaction.reply({ content: 'このセッションは終了済みで、編集期限も過ぎています。', ephemeral: true });
          return;
        }
      }

      if (interaction.channelId !== session.threadId) {
        await interaction.reply({ content: 'この操作はセッションスレッド内で行ってください。', ephemeral: true });
        return;
      }

      const [_, action, nStr] = interaction.customId.split(':');
      const sliceSeq = Number(nStr);

      if (!Number.isInteger(sliceSeq) || sliceSeq < 1) {
        await interaction.reply({ content: 'スライス番号が不正です。', ephemeral: true });
        return;
      }

      if (action === 'goal') {
        if (sliceSeq > session.sliceSeq + 1) {
          await interaction.reply({ content: '（まだ先のスライスの目標は入力できません）', ephemeral: true });
          return;
        }
        return await openGoalModal(interaction, sliceSeq);
      }

      if (action === 'result') {
        if (sliceSeq > session.sliceSeq) {
          await interaction.reply({ content: '（まだ始まっていないスライスの結果は入力できません）', ephemeral: true });
          return;
        }
        return await openResultModal(interaction, sliceSeq);
      }

      return;
    }

    if (interaction.isModalSubmit()) {
      if (!session) {
        await interaction.reply({ content: 'セッション情報がありません。', ephemeral: true });
        return;
      }

      if (session.phase === 'done') {
        const ok = Date.now() < (session.editWindowUntilMs || 0);
        if (!ok) {
          await interaction.reply({ content: 'このセッションは終了済みで、編集期限も過ぎています。', ephemeral: true });
          return;
        }
      }

      // ★ここから重い処理（サマリー全更新）をするので defer
      await interaction.deferReply({ ephemeral: true });

      const [_, kind, nStr] = interaction.customId.split(':');
      const sliceSeq = Number(nStr);

      if (!Number.isInteger(sliceSeq) || sliceSeq < 1) {
        await interaction.editReply({ content: 'スライス番号が不正です。' });
        return;
      }

      if (kind === 'goalModal' && sliceSeq > session.sliceSeq + 1) {
        await interaction.editReply({ content: '（まだ先のスライスの目標は入力できません）' });
        return;
      }
      if (kind === 'resultModal' && sliceSeq > session.sliceSeq) {
        await interaction.editReply({ content: '（まだ始まっていないスライスの結果は入力できません）' });
        return;
      }

      const data = ensureParticipant(interaction.user.id);

      // interaction.channel を信用しない
      const thread = await interaction.guild.channels
        .fetch(session.threadId)
        .catch(() => null);

      if (!thread) {
        await interaction.editReply({ content: 'スレッドが見つかりませんでした。' });
        return;
      }

      if (kind === 'goalModal') {
        const text = interaction.fields.getTextInputValue('goalText').trim();
        data.goals[sliceSeq - 1] = text;

        // 次スライス目標を先に書いた場合の仮メタ（サマリー崩れ防止）
        if (!session.sliceMeta[sliceSeq]) {
          const isAfterLongBreak = session.phase === 'longBreak' || session.pausedFrom === 'longBreak';
          const pom = isAfterLongBreak ? (session.pomodoroIndex + 1) : session.pomodoroIndex;
          const sliceInPom = isAfterLongBreak ? 1 : (session.sliceInPomodoro + 1);

          session.sliceMeta[sliceSeq] = { pomodoro: pom, sliceInPomodoro: sliceInPom };
          if (!session.pomodoroSlices[pom]) session.pomodoroSlices[pom] = [];
          if (!session.pomodoroSlices[pom].includes(sliceSeq)) session.pomodoroSlices[pom].push(sliceSeq);
          session.pomodoroSlices[pom].sort((a, b) => a - b);
        }

        const body = text || '（未入力）';
        const content = `**${safeName(interaction)}** 目標（スライス#${sliceSeq}）：\n${body}`;

        const prevId = data.goalMsgIds[sliceSeq - 1];
        if (prevId) {
          try {
            const msg = await thread.messages.fetch(prevId);
            await msg.edit(content);
          } catch {
            const msg = await thread.send(content);
            data.goalMsgIds[sliceSeq - 1] = msg.id;
          }
        } else {
          const msg = await thread.send(content);
          data.goalMsgIds[sliceSeq - 1] = msg.id;
        }

        // ★要望：目標/結果を変えたら「各ポモサマリー＋最終」全部を書き換え
        await updateAllSummaries(thread);

        await interaction.editReply({ content: `目標を保存しました（スライス#${sliceSeq}）。` });
        return;
      }

      if (kind === 'resultModal') {
        const text = interaction.fields.getTextInputValue('resultText').trim();
        data.results[sliceSeq - 1] = text;

        const body = text || '（未入力）';
        const content = `**${safeName(interaction)}** 結果（スライス#${sliceSeq}）：\n${body}`;

        const prevId = data.resultMsgIds[sliceSeq - 1];
        if (prevId) {
          try {
            const msg = await thread.messages.fetch(prevId);
            await msg.edit(content);
          } catch {
            const msg = await thread.send(content);
            data.resultMsgIds[sliceSeq - 1] = msg.id;
          }
        } else {
          const msg = await thread.send(content);
          data.resultMsgIds[sliceSeq - 1] = msg.id;
        }

        await updateAllSummaries(thread);

        await interaction.editReply({ content: `結果を保存しました（スライス#${sliceSeq}）。` });
        return;
      }

      await interaction.editReply({ content: '不明なモーダルです。' });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: 'エラーが発生しました（ログを確認してください）。', ephemeral: true });
        } else {
          await interaction.reply({ content: 'エラーが発生しました（ログを確認してください）。', ephemeral: true });
        }
      } catch (_) {}
    }
  }
});

// ======= Bot login =======
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
