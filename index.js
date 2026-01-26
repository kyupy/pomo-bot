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
} = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ======= グローバル（同時セッションなし）状態 =======
let session = null;
// session = {
//   threadId, forumId, mode, dateStr,
//   focusMin, breakMin, rounds,
//   phase: 'idle'|'focus'|'break'|'done',
//   round: 0,
//   participants: Map<userId, { goals: string[], results: string[] }>
//   timeouts: NodeJS.Timeout[],
//   startedAt: unix,
// }

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function jstDateString() {
  // 例: 2026-01-22 (Asia/Tokyo)
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

function isStopAllowed(interaction) {
  const owner = process.env.OWNER_USER_ID;
  if (owner && interaction.user.id === owner) return true;
  // サーバー管理者権限を持つ人のみ
  const member = interaction.member;
  return member && member.permissions && member.permissions.has(PermissionFlagsBits.Administrator);
}

function clearAllTimeouts() {
  if (!session) return;
  for (const t of session.timeouts) clearTimeout(t);
  session.timeouts = [];
}

async function fetchForumChannel(guild) {
  const forumId = process.env.FORUM_CHANNEL_ID;
  const ch = await guild.channels.fetch(forumId);
  if (!ch) throw new Error('FORUM_CHANNEL_ID: channel not found');
  if (ch.type !== ChannelType.GuildForum) throw new Error('FORUM_CHANNEL_ID is not a forum channel');
  return ch;
}

function buildRoundRow(round) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pomo:goal:${round}`)
      .setLabel(`目標入力（#${round}）`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`pomo:result:${round}`)
      .setLabel(`結果入力（#${round}）`)
      .setStyle(ButtonStyle.Success),
  );
}

function safeName(interaction) {
  // サーバー内表示名が取れるならそれ、なければ username
  const dn = interaction.member?.displayName;
  return dn || interaction.user.username;
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

async function postThreadMessage(thread, content, components) {
  const payload = { content };
  if (components) payload.components = [components];
  return thread.send(payload);
}

async function getNextIndexForPrefix(forumChannel, basePrefix) {
  // basePrefix: "self-2026-01-23" など
  const re = new RegExp(`^${basePrefix}-(\\d+)$`);

  let max = 0;

  // アクティブスレッド（未アーカイブ）
  const active = await forumChannel.threads.fetchActive();
  for (const [, th] of active.threads) {
    const m = th.name.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }

  // アーカイブ済み（直近）も見る：デフォルトで最近の分は十分拾える
  // 取りこぼしが気になるならループでページング可能（下に補足あり）
  const archived = await forumChannel.threads.fetchArchived({ limit: 100 });
  for (const [, th] of archived.threads) {
    const m = th.name.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }

  return max + 1;
}

async function startRound(thread, round) {
  session.phase = 'focus';
  session.round = round;

  const focusEnd = unixNow() + session.focusMin * 60;

  // 相対タイムスタンプで「あと◯分」を表示（クライアント側で更新）
  const msg =
    `**集中 #${round}（${session.focusMin}分）**\n` +
    `終了：<t:${focusEnd}:R>（<t:${focusEnd}:t>）\n` +
    `囚人作業会開始！`;

  await postThreadMessage(thread, msg, buildRoundRow(round));

  session.timeouts.push(setTimeout(async () => {
    await endFocus(thread, round);
  }, session.focusMin * 60 * 1000));
}

async function endFocus(thread, round) {
  // 結果入力を促す
  await postThreadMessage(
    thread,
    `集中 #${round} 終了。結果を入力してください。`,
    buildRoundRow(round)
  );

  if (round >= session.rounds) {
  // 最終ラウンドも休憩を入れて、その間に結果入力してもらう
  session.phase = 'break';

  // breakMin が 0 の場合は即サマリー（ただし入力時間がないので非推奨）
  const breakMin = session.breakMin ?? 0;
  if (breakMin <= 0) {
    // 最低限の猶予を入れるなら 10秒なども可
    await finalizeSession(thread);
    return;
  }

  const breakEnd = unixNow() + breakMin * 60;
  await postThreadMessage(
    thread,
    `**最終休憩（${breakMin}分）**\n` +
    `サマリーは <t:${breakEnd}:R>（<t:${breakEnd}:t>）に出します。\n` +
    `この休憩中に「結果入力（#${round}）」を押してください。`
  );

  session.timeouts.push(setTimeout(async () => {
    await finalizeSession(thread);
  }, breakMin * 60 * 1000));

  return;
}


  session.phase = 'break';
  const breakEnd = unixNow() + session.breakMin * 60;

  await postThreadMessage(
    thread,
    `**休憩 #${round}（${session.breakMin}分）**\n終了：<t:${breakEnd}:R>（<t:${breakEnd}:t>）`
  );

  session.timeouts.push(setTimeout(async () => {
    await startRound(thread, round + 1);
  }, session.breakMin * 60 * 1000));
}

async function postSummary(thread) {
  const lines = [];
  lines.push('---');
  lines.push('**サマリ**（目標 / 結果）');

  for (const [userId, data] of session.participants.entries()) {
    const mention = `<@${userId}>`;
    for (let i = 0; i < session.rounds; i++) {
      const g = data.goals[i] ?? '（未入力）';
      const r = data.results[i] ?? '（未入力）';
      lines.push(`- ${mention} #${i + 1} 目標：${g} / 結果：${r}`);
    }
  }

  await postThreadMessage(thread, lines.join('\n'));
}

async function finalizeSession(thread) {
  session.phase = 'done';
  await postThreadMessage(thread, `本日の囚人作業会終了。おつかれさまでした！`);
  await postSummary(thread);

  // ★終了したらアーカイブ
  try {
    await thread.setArchived(true);
  } catch (_) {}
}

// ======= Interaction handlers =======
async function handlePomoStart(interaction) {
  if (session && session.phase !== 'done') {
    await interaction.reply({ content: 'すでに囚人作業会が進行中です。/pomo status を確認してください。', ephemeral: true });
    return;
  }

  const mode = interaction.options.getString('mode', true);
  const focusMin = interaction.options.getInteger('focus') ?? 25;
  const breakMin = interaction.options.getInteger('break') ?? 5;
  const rounds = interaction.options.getInteger('rounds') ?? 4;

  const dateStr = jstDateString();
  const basePrefix = `${mode}-${dateStr}`;

  const forum = await fetchForumChannel(interaction.guild);

    // ★ここで採番してタイトル決定
  const idx = await getNextIndexForPrefix(forum, basePrefix); 
  const title = `${basePrefix}-${idx}`;


  // フォーラム投稿（= スレッド）作成
  const thread = await forum.threads.create({
    name: title,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    message: {
      content:
        `**${title}**\n` +
        `focus ${focusMin} / break ${breakMin} / rounds ${rounds}\n` +
        `各ラウンドの「目標入力」「結果入力」ボタンから記録できます（任意）。`,
    },
  });

  session = {
    threadId: thread.id,
    forumId: forum.id,
    mode,
    dateStr,
    focusMin,
    breakMin,
    rounds,
    phase: 'idle',
    round: 0,
    participants: new Map(),
    timeouts: [],
    startedAt: unixNow(),
  };

  await interaction.reply({
    content: `開始しました：${thread.toString()} （タイトル: ${title}）`,
    ephemeral: true,
  });

  // すぐRound1開始
  await startRound(thread, 1);
}

async function handlePomoStop(interaction) {
  if (!session || session.phase === 'done') {
    await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
    return;
  }
  if (!isStopAllowed(interaction)) {
    await interaction.reply({ content: '停止できるのは管理者（または OWNER_USER_ID）だけです。', ephemeral: true });
    return;
  }

  clearAllTimeouts();

  const thread = await interaction.guild.channels.fetch(session.threadId);
  if (thread) {
    await thread.send('管理者によりセッションが停止されました。');
  }

  session.phase = 'done';
  await interaction.reply({ content: '停止しました。', ephemeral: true });
}

async function handlePomoStatus(interaction) {
  if (!session || session.phase === 'done') {
    await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
    return;
  }
  const thread = await interaction.guild.channels.fetch(session.threadId);
  const pCount = session.participants.size;
  await interaction.reply({
    content:
      `現在のセッション：${thread ? thread.toString() : session.threadId}\n` +
      `状態：${session.phase} / round ${session.round}/${session.rounds}\n` +
      `参加者：${pCount}人`,
    ephemeral: true,
  });
}

async function openGoalModal(interaction, round) {
  const modal = new ModalBuilder()
    .setCustomId(`pomo:goalModal:${round}`)
    .setTitle(`目標入力（#${round}）`);

  const input = new TextInputBuilder()
    .setCustomId('goalText')
    .setLabel('このポモでやること（任意）')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function openResultModal(interaction, round) {
  const modal = new ModalBuilder()
    .setCustomId(`pomo:resultModal:${round}`)
    .setTitle(`結果入力（#${round}）`);

  const input = new TextInputBuilder()
    .setCustomId('resultText')
    .setLabel('このポモでやったこと（任意）')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

client.on('interactionCreate', async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'pomo') return;

      const sub = interaction.options.getSubcommand();
      if (sub === 'start') return await handlePomoStart(interaction);
      if (sub === 'stop') return await handlePomoStop(interaction);
      if (sub === 'status') return await handlePomoStatus(interaction);
      return;
    }

    // Buttons
    if (interaction.isButton()) {
      if (!session || session.phase === 'done') {
        await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
        return;
      }
      if (interaction.channelId !== session.threadId) {
        await interaction.reply({ content: 'この操作はセッションスレッド内で行ってください。', ephemeral: true });
        return;
      }

      const [_, action, maybeRound] = interaction.customId.split(':'); // pomo:join / pomo:goal:1 etc

      const round = Number(maybeRound);
      if (!Number.isInteger(round) || round < 1 || round > session.rounds) {
        await interaction.reply({ content: 'ラウンド番号が不正です。', ephemeral: true });
        return;
      }

      if (action === 'goal') return await openGoalModal(interaction, round);
      if (action === 'result') return await openResultModal(interaction, round);

      return;
    }

    // Modals
    if (interaction.isModalSubmit()) {
      if (!session || session.phase === 'done') {
        await interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
        return;
      }
      if (interaction.channelId !== session.threadId) {
        await interaction.reply({ content: 'この操作はセッションスレッド内で行ってください。', ephemeral: true });
        return;
      }

      const [_, kind, roundStr] = interaction.customId.split(':'); // pomo:goalModal:1
      const round = Number(roundStr);

      if (!session.participants.has(interaction.user.id)) ensureParticipant(interaction.user.id);
      const data = ensureParticipant(interaction.user.id);

      if (kind === 'goalModal') {
        const text = interaction.fields.getTextInputValue('goalText').trim();
        data.goals[round - 1] = text;

        // ★スレッドに可視化（@mentionしない）
        const thread = interaction.channel; // この時点でセッションスレッドのはず
        const content = `**${safeName(interaction)}** 目標 #${round}：${text || '（未入力）'}`;

        // 既に投稿済みなら編集、初回なら投稿
        const prevId = data.goalMsgIds[round - 1];
        if (prevId) {
            try {
            const msg = await thread.messages.fetch(prevId);
            await msg.edit(content);
            } catch {
            const msg = await thread.send(content);
            data.goalMsgIds[round - 1] = msg.id;
            }
        } else {
            const msg = await thread.send(content);
            data.goalMsgIds[round - 1] = msg.id;
        }

        await interaction.reply({ content: `目標を保存しました（#${round}）。`, ephemeral: true });
        return;
      }

      if (kind === 'resultModal') {
        const text = interaction.fields.getTextInputValue('resultText').trim();
        data.results[round - 1] = text;

        // ★スレッドに可視化（@mentionしない）
        const thread = interaction.channel;
        const content = `**${safeName(interaction)}** 結果 #${round}：${text || '（未入力）'}`;

        const prevId = data.resultMsgIds[round - 1];
        if (prevId) {
            try {
            const msg = await thread.messages.fetch(prevId);
            await msg.edit(content);
            } catch {
            const msg = await thread.send(content);
            data.resultMsgIds[round - 1] = msg.id;
            }
        } else {
            const msg = await thread.send(content);
            data.resultMsgIds[round - 1] = msg.id;
        }

        await interaction.reply({ content: `結果を保存しました（#${round}）。`, ephemeral: true });
        return;
      }


      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      // 既に返信済みの場合は followUp
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

const { Events } = require('discord.js');

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
