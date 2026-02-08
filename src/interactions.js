const { getSession, ensureSession, safeName, setGoal, setResult, fetchThread, fetchTimerChannel } = require('./state');
const { renderTimer } = require('./ui_timer');
const { logThread } = require('./ui_thread');
const commands = require('./commands');

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');

function currentGoalSlice() {
  const s = ensureSession();
  if (s.phase === 'shortBreak' || s.phase === 'longBreak') return s.sliceSeq + 1;
  return Math.max(1, s.sliceSeq);
}
function currentPrevSlice() {
  const s = ensureSession();
  return Math.max(1, s.sliceSeq);
}

async function openTextModal(interaction, kind, sliceSeq, withSlicePicker = false) {
  const title =
    kind === 'goal'
      ? (withSlicePicker ? '目標（指定）' : `目標（#${sliceSeq}）`)
      : (withSlicePicker ? '結果（指定）' : `結果（#${sliceSeq}）`);

  const modal = new ModalBuilder()
    .setCustomId(withSlicePicker ? `pomo:modal:${kind}:pick` : `pomo:modal:${kind}:${sliceSeq}`)
    .setTitle(title);

  const rows = [];

  if (withSlicePicker) {
    const sliceInput = new TextInputBuilder()
      .setCustomId('slice')
      .setLabel('スライス番号（通し）')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(6)
      .setRequired(true);
    rows.push(new ActionRowBuilder().addComponents(sliceInput));
  }

  const textInput = new TextInputBuilder()
    .setCustomId('text')
    .setLabel(kind === 'goal' ? '目標テキスト（後で編集OK）' : '結果テキスト（後で編集OK）')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(true);

  rows.push(new ActionRowBuilder().addComponents(textInput));

  modal.addComponents(...rows);
  await interaction.showModal(modal);
}

function registerHandlers(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      // Slash commands
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName !== 'pomo') return;
        const sub = interaction.options.getSubcommand();

        if (sub === 'start') return commands.handleStart(interaction);
        if (sub === 'stop') return commands.handleStop(interaction);
        if (sub === 'pause') return commands.handlePause(interaction);
        if (sub === 'resume') return commands.handleResume(interaction);
        if (sub === 'status') return commands.handleStatus(interaction);

        if (sub === 'join') return commands.handleJoin(interaction);
        if (sub === 'leave') return commands.handleLeave(interaction);

        if (sub === 'edit-goal') return commands.handleEditGoal(interaction);
        if (sub === 'edit-result') return commands.handleEditResult(interaction);

        return;
      }

      // Buttons (タイマーチャンネルでのみ)
      if (interaction.isButton()) {
        const s = getSession();
        if (!s) return interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });
        if (interaction.channelId !== s.timerChannelId) {
          return interaction.reply({ content: '操作はタイマーチャンネルのパネルから行ってください。', ephemeral: true });
        }

        if (interaction.customId === 'pomo:join') return commands.handleJoin(interaction);
        if (interaction.customId === 'pomo:leave') return commands.handleLeave(interaction);

        if (interaction.customId === 'pomo:goal:now') {
          return openTextModal(interaction, 'goal', currentGoalSlice(), false);
        }
        if (interaction.customId === 'pomo:result:prev') {
          return openTextModal(interaction, 'result', currentPrevSlice(), false);
        }
        if (interaction.customId === 'pomo:goal:pick') {
          return openTextModal(interaction, 'goal', 1, true);
        }
        if (interaction.customId === 'pomo:result:pick') {
          return openTextModal(interaction, 'result', 1, true);
        }

        return;
      }

      // Modals
      if (interaction.isModalSubmit()) {
        const s = getSession();
        if (!s) return interaction.reply({ content: '進行中セッションはありません。', ephemeral: true });

        const timerChannel = await fetchTimerChannel(interaction.guild);
        const thread = await fetchThread(interaction.guild);

        const parts = interaction.customId.split(':'); // pomo:modal:goal:3 OR pomo:modal:goal:pick
        const kind = parts[2]; // goal/result
        const tail = parts[3];

        let slice = null;

        if (tail === 'pick') {
          const sliceStr = interaction.fields.getTextInputValue('slice').trim();
          slice = Number(sliceStr);
        } else {
          slice = Number(tail);
        }

        if (!Number.isInteger(slice) || slice < 1) {
          return interaction.reply({ content: 'スライス番号が不正です。', ephemeral: true });
        }

        // 目標は最大 sliceSeq+1 まで、結果は最大 sliceSeq まで
        if (kind === 'goal') {
          const maxGoal = Math.max(1, s.sliceSeq + 1);
          if (slice > maxGoal) {
            return interaction.reply({ content: `目標は #${maxGoal} まで入力できます。`, ephemeral: true });
          }
        }
        if (kind === 'result') {
          const maxRes = Math.max(1, s.sliceSeq);
          if (slice > maxRes) {
            return interaction.reply({ content: `結果は #${maxRes} まで入力できます。`, ephemeral: true });
          }
        }

        const text = interaction.fields.getTextInputValue('text').trim();

        if (kind === 'goal') {
          setGoal(slice, interaction.user.id, text);
          await logThread(thread, `🎯 ${safeName(interaction)}：目標（#${slice}）\n${text}`);
        } else if (kind === 'result') {
          setResult(slice, interaction.user.id, text);
          await logThread(thread, `🧾 ${safeName(interaction)}：結果（#${slice}）\n${text}`);
        } else {
          return interaction.reply({ content: '不明な種類です。', ephemeral: true });
        }

        await renderTimer(timerChannel);
        return interaction.reply({ content: `保存しました（#${slice}）。`, ephemeral: true });
      }
    } catch (e) {
      console.error(e);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: 'エラー（ログ参照）', ephemeral: true });
        } else {
          await interaction.reply({ content: 'エラー（ログ参照）', ephemeral: true });
        }
      } catch (_) {}
    }
  });
}

module.exports = { registerHandlers };
