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
  currentPhaseEndsAtMs,        // 進行中フェーズの終了予定(ミリ秒)
  currentPhaseRemainingMs,     // pause時に保持
  currentPhaseMessageId,       // 1分更新してるメッセージ
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

function buildSliceRow(sliceSeq) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pomo:goal:${sliceSeq}`)
      .setLabel(`目標入力（スライス#${sliceSeq}）`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`pomo:result:${sliceSeq}`)
      .setLabel(`結果入力（スライス#${sliceSeq}）`)
      .setStyle(ButtonStyle.Success),
  );
}

function formatHHMMSS(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}時間${m}分${s}秒`;
}

function formatRemaining(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}分${s.toString().padStart(2, '0')}秒`;
}

// ======= 1分ごとの編集タイマー（フェーズ開始メッセージがそのまま更新される） =======
async function startEditableCountdown({
  thread,
  titleLine,
  durationMs,
  headerLines = [],
  components = null,
}) {
  const endAt = Date.now() + durationMs;
  session.currentPhaseEndsAtMs = endAt;

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

  const msg = await thread.send({
    content: contentOf(),
    components: components ? [components] : [],
  });

  session.currentPhaseMessageId = msg.id;

  // 1分ごとに編集（要望）
  const interval = setInterval(async () => {
    try {
      await msg.edit(contentOf());
    } catch (_) {}
  }, 60 * 1000);
  session.intervals.push(interval);

  // 終了時にintervalを止める（stop/pauseでも止めるけど念のため）
  const cleanup = setTimeout(() => {
    clearInterval(interval);
  }, durationMs);
  session.timeouts.push(cleanup);

  return { msg, endAt };
}

// ======= 進行ロジック（メッセージの流れを明示） =======
async function announcePomodoroStart(thread) {
  await postThreadMessage(thread, `## ポモ#${session.pomodoroIndex} 開始`);
}

async function announcePomodoroEnd(thread) {
  await postThreadMessage(thread, `## ポモ#${session.pomodoroIndex} 終了`);
}

async function startFocus(thread) {
  session.phase = 'focus';
  session.sliceSeq += 1;
  const sliceSeq = session.sliceSeq;
  const p = session.pomodoroIndex;
  const s = session.sliceInPomodoro;

  await postThreadMessage(thread, `### ポモ#${p} スライス${s} 開始（通しスライス#${sliceSeq}）`);

  const durationMs = session.currentPhaseRemainingMs ?? (session.sliceMin * 60 * 1000);
  session.currentPhaseRemainingMs = null;

  await startEditableCountdown({
    thread,
    titleLine: `**集中**（${session.sliceMin}分）`,
    durationMs,
    headerLines: [
      `囚人作業会：ポモ#${p} / スライス${s}/${session.slicesPerPomodoro}（通し#${sliceSeq}）`,
      `（目標/結果ボタンはこのメッセージにあります）`,
    ],
    components: buildSliceRow(sliceSeq),
  });

  session.timeouts.push(setTimeout(async () => {
    await onFocusEnd(thread, sliceSeq);
  }, durationMs));
}

async function onFocusEnd(thread, sliceSeq) {
  // スライス終了の明示メッセージ
  await postThreadMessage(thread, `### ポモ#${session.pomodoroIndex} スライス${session.sliceInPomodoro} 終了（通しスライス#${sliceSeq}）`);
  // 結果入力促し（ボタン再掲）
  await postThreadMessage(thread, `結果入力してください（通しスライス#${sliceSeq}）。`, buildSliceRow(sliceSeq));

  const isLast = session.sliceInPomodoro >= session.slicesPerPomodoro;

  // ★ここで「ポモ終了」を出す（長休憩に入った瞬間＝ポモ終了）
  if (isLast) {
    await announcePomodoroEnd(thread);
  }

  // 次は休憩
  session.phase = isLast ? 'longBreak' : 'shortBreak';

  const breakMin = isLast ? session.longBreakMin : session.shortBreakMin;
  const durationMs = session.currentPhaseRemainingMs ?? (breakMin * 60 * 1000);
  session.currentPhaseRemainingMs = null;

  await startEditableCountdown({
    thread,
    titleLine: isLast ? `**長休憩**（${breakMin}分）` : `**休憩**（${breakMin}分）`,
    durationMs,
    headerLines: [
      `囚人作業会：ポモ#${session.pomodoroIndex} / スライス${session.sliceInPomodoro}/${session.slicesPerPomodoro}（通し#${sliceSeq}）`,
      `（休憩中に結果入力してOK）`,
    ],
    components: null,
  });

  session.timeouts.push(setTimeout(async () => {
    await onBreakEnd(thread, isLast);
  }, durationMs));
}


async function onBreakEnd(thread, wasLongBreak) {
  if (wasLongBreak) {
    // （ポモ終了メッセージは長休憩開始時に出している）

    // 次のポモへ
    session.pomodoroIndex += 1;
    session.sliceInPomodoro = 1;

    await announcePomodoroStart(thread);
    await startFocus(thread);
    return;
  }

  // 小休憩が終わったら次スライス
  session.sliceInPomodoro += 1;
  await startFocus(thread);
}


// ======= サマリ（stop時） =======
async function postSummary(thread) {
  const lines = [];
  lines.push('---');
  lines.push('**サマリ（目標 / 結果）**');

  for (const [userId, data] of session.participants.entries()) {
    const mention = `<@${userId}>`;
    for (let i = 0; i < session.sliceSeq; i++) {
      const g = data.goals[i] ?? '（未入力）';
      const r = data.results[i] ?? '（未入力）';
      lines.push(`- ${mention} スライス#${i + 1} 目標：${g} / 結果：${r}`);
    }
  }
  await postThreadMessage(thread, lines.join('\n'));
}

function computeActiveMsNow() {
  const now = Date.now();
  const paused = session.pauseStartedAtMs ? (now - session.pauseStartedAtMs) : 0;
  return (now - session.startedAtMs) - session.pausedMsAccum - paused;
}

async function finalizeSession(thread, stoppedByText) {
  session.phase = 'done';

  const pomosDone = session.pomodoroIndex - 1; // 完了したポモ数（現在進行中は含めない）
  const slicesDone = session.sliceSeq;
  const activeMs = computeActiveMsNow();

  await postThreadMessage(
    thread,
    `# 囚人作業会終了\n` +
    `${stoppedByText}\n` +
    `完了：**${pomosDone}ポモ / ${slicesDone}スライス**\n` +
    `合計作業時間（停止時間除く）：**${formatHHMMSS(activeMs)}**`
  );

  await postSummary(thread);

  try { await thread.setArchived(true); } catch (_) {}
}

// ======= Pause/Resume =======
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

  // 残り時間を保持
  const remain = Math.max(0, session.currentPhaseEndsAtMs - Date.now());
  session.currentPhaseRemainingMs = remain;

  clearAllTimers();
  session.pauseStartedAtMs = Date.now();
  session.phase = 'paused';

  const thread = await interaction.guild.channels.fetch(session.threadId);
  if (thread) await thread.send('⏸️ 一時停止しました。/pomo resume で再開できます。');

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
  if (thread) await thread.send('▶️ 再開します。');

  // どのフェーズから再開するか：paused直前のフェーズ名を保持してないので
  // 「currentPhaseRemainingMs」がある前提で、いまの sliceInPomodoro/sliceSeq/phaseから復元する
  // phase は paused になっているので、残りがあるなら直前が focus or break のはず：
  // ここでは「直前メッセージを編集し直す」より、再開メッセージとして再度カウントを出す（簡潔＆安全）
  // 直前が集中だったか休憩だったかを推定：sliceSeqは既に開始時に増えているので、
  // pauseした時点のphaseが paused になる前に focus/shortBreak/longBreak のどれかだったはず。
  // それを保存しておくために、pause前のphaseを保存する：
  // → ここでは簡単に session.lastPhase を使う設計にしてないので、下で用意する
  // 代わりに：pause時に session.pausedFrom を保存しておく
  await interaction.reply({ content: '再開しました。', ephemeral: true });

  // 再開は「pausedFrom」で分岐
  const from = session.pausedFrom;
  if (from === 'focus') return await startFocus(thread);
  if (from === 'shortBreak' || from === 'longBreak') {
    // 休憩再開：sliceSeqは変えず、onFocusEnd内の休憩部分と同等が必要。
    // ここは簡単に「休憩を再開する専用関数」で再開する。
    return await resumeBreak(thread);
  }

  // ここまで来るのは想定外：安全に次の集中を始める
  return await startFocus(thread);
}

async function resumeBreak(thread) {
  // いまの状態から「長休憩か小休憩か」を推定
  const isLast = session.sliceInPomodoro >= session.slicesPerPomodoro;
  const breakMin = (session.pausedFrom === 'longBreak' || isLast) ? session.longBreakMin : session.shortBreakMin;
  const durationMs = session.currentPhaseRemainingMs ?? (breakMin * 60 * 1000);
  session.currentPhaseRemainingMs = null;

  const sliceSeq = session.sliceSeq;

  session.phase = (session.pausedFrom === 'longBreak' || isLast) ? 'longBreak' : 'shortBreak';

  await startEditableCountdown({
    thread,
    titleLine: (session.phase === 'longBreak') ? `**長休憩**（${breakMin}分）` : `**休憩**（${breakMin}分）`,
    durationMs,
    headerLines: [
      `囚人作業会：ポモ#${session.pomodoroIndex} / スライス${session.sliceInPomodoro}/${session.slicesPerPomodoro}（通し#${sliceSeq}）`,
      `（休憩中に結果入力してOK）`,
    ],
  });

  session.timeouts.push(setTimeout(async () => {
    await onBreakEnd(thread, session.phase === 'longBreak');
  }, durationMs));
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
  };

  await interaction.reply({
    content: `開始しました：${thread.toString()} （タイトル: ${title}）`,
    ephemeral: true,
  });

  // メッセージの流れ：開始 → ポモ開始 → スライス開始…
  await thread.send('# 囚人作業会開始');
  await announcePomodoroStart(thread);

  await startFocus(thread);
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

  // pause中なら pause時間を確定
  if (session.pauseStartedAtMs) {
    session.pausedMsAccum += (Date.now() - session.pauseStartedAtMs);
    session.pauseStartedAtMs = null;
  }

  clearAllTimers();

  const thread = await interaction.guild.channels.fetch(session.threadId);
  if (thread) {
    await finalizeSession(thread, `停止者：${safeName(interaction)}`);
  }

  await interaction.reply({ content: '停止しました。', ephemeral: true });
}

async function handlePomoStatus(interaction) {
  if (!session || session.phase === 'done') {
    await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
    return;
  }
  const thread = await interaction.guild.channels.fetch(session.threadId);

  const activeMs = computeActiveMsNow();
  await interaction.reply({
    content:
      `現在：${thread ? thread.toString() : session.threadId}\n` +
      `状態：${session.phase}\n` +
      `ポモ#${session.pomodoroIndex} / スライス${session.sliceInPomodoro}/${session.slicesPerPomodoro} / 通しスライス#${session.sliceSeq}\n` +
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

        // pause前のphaseを保存（resumeで使う）
        session.pausedFrom = session.phase;

        return await handlePause(interaction);
      }
      if (sub === 'resume') return await handleResume(interaction);
      if (sub === 'stop') return await handlePomoStop(interaction);
      if (sub === 'status') return await handlePomoStatus(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (!session || session.phase === 'done') {
        await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
        return;
      }
      if (interaction.channelId !== session.threadId) {
        await interaction.reply({ content: 'この操作はセッションスレッド内で行ってください。', ephemeral: true });
        return;
      }

      const [_, action, nStr] = interaction.customId.split(':');
      const sliceSeq = Number(nStr);

      if (!Number.isInteger(sliceSeq) || sliceSeq < 1 || sliceSeq > session.sliceSeq) {
        await interaction.reply({ content: 'スライス番号が不正です。', ephemeral: true });
        return;
      }

      if (action === 'goal') return await openGoalModal(interaction, sliceSeq);
      if (action === 'result') return await openResultModal(interaction, sliceSeq);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (!session || session.phase === 'done') {
        await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
        return;
      }
      if (interaction.channelId !== session.threadId) {
        await interaction.reply({ content: 'この操作はセッションスレッド内で行ってください。', ephemeral: true });
        return;
      }

      const [_, kind, nStr] = interaction.customId.split(':');
      const sliceSeq = Number(nStr);
      if (!Number.isInteger(sliceSeq) || sliceSeq < 1 || sliceSeq > session.sliceSeq) {
        await interaction.reply({ content: 'スライス番号が不正です。', ephemeral: true });
        return;
      }

      const data = ensureParticipant(interaction.user.id);
      const thread = interaction.channel;

      if (kind === 'goalModal') {
        const text = interaction.fields.getTextInputValue('goalText').trim();
        data.goals[sliceSeq - 1] = text;

        const content = `**${safeName(interaction)}** 目標（スライス#${sliceSeq}）：${text || '（未入力）'}`;
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

        await interaction.reply({ content: `目標を保存しました（スライス#${sliceSeq}）。`, ephemeral: true });
        return;
      }

      if (kind === 'resultModal') {
        const text = interaction.fields.getTextInputValue('resultText').trim();
        data.results[sliceSeq - 1] = text;

        const content = `**${safeName(interaction)}** 結果（スライス#${sliceSeq}）：${text || '（未入力）'}`;
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

        await interaction.reply({ content: `結果を保存しました（スライス#${sliceSeq}）。`, ephemeral: true });
        return;
      }
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

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
