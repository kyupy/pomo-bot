const { ChannelType } = require('discord.js');

let session = null;

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

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

function getSession() {
  return session;
}
function ensureSession() {
  if (!session) throw new Error('No session');
  return session;
}
function setSession(s) {
  session = s;
}
function clearSession() {
  session = null;
}

// --- permissions (host/admin/owner) ---
function isControlAllowed(interaction) {
  const owner = process.env.OWNER_USER_ID;
  if (owner && interaction.user.id === owner) return true;
  if (session?.hostId && interaction.user.id === session.hostId) return true;
  const member = interaction.member;
  return !!member?.permissions?.has('Administrator');
}

// --- timers ---
function clearAllTimers() {
  if (!session) return;
  for (const t of session.timeouts) clearTimeout(t);
  for (const i of session.intervals) clearInterval(i);
  session.timeouts = [];
  session.intervals = [];
}

// --- participants/time accounting ---
function ensureParticipant(userId, name) {
  const s = ensureSession();
  if (!s.participants.has(userId)) {
    s.participants.set(userId, {
      name: name ?? userId,
      isActive: false,
      joinedAtMs: null,
      activeMsAccum: 0,
    });
  }
  const p = s.participants.get(userId);
  if (name) p.name = name;
  return p;
}

function joinParticipant(userId, name) {
  const p = ensureParticipant(userId, name);
  if (!p.isActive) {
    p.isActive = true;
    p.joinedAtMs = Date.now();
  }
  return p;
}

function leaveParticipant(userId, name) {
  const p = ensureParticipant(userId, name);
  if (p.isActive) {
    const now = Date.now();
    p.activeMsAccum += Math.max(0, now - (p.joinedAtMs ?? now));
    p.isActive = false;
    p.joinedAtMs = null;
  }
  return p;
}

function finalizeAllParticipants() {
  const s = ensureSession();
  const now = Date.now();
  for (const [, p] of s.participants) {
    if (p.isActive) {
      p.activeMsAccum += Math.max(0, now - (p.joinedAtMs ?? now));
      p.isActive = false;
      p.joinedAtMs = null;
    }
  }
}

function getParticipantActiveMsNow(p) {
  const now = Date.now();
  return p.activeMsAccum + (p.isActive && p.joinedAtMs ? Math.max(0, now - p.joinedAtMs) : 0);
}

// --- slice data (THE TRUTH) ---
function ensureSlice(sliceSeq) {
  const s = ensureSession();
  if (!s.slices.has(sliceSeq)) {
    s.slices.set(sliceSeq, {
      goalByUser: new Map(),
      resultByUser: new Map(),
    });
  }
  return s.slices.get(sliceSeq);
}
function setGoal(sliceSeq, userId, text) {
  ensureSlice(sliceSeq).goalByUser.set(userId, text);
}
function setResult(sliceSeq, userId, text) {
  ensureSlice(sliceSeq).resultByUser.set(userId, text);
}

// --- channel fetch helpers ---
async function fetchForumChannel(guild) {
  const forumId = mustEnv('FORUM_CHANNEL_ID');
  const ch = await guild.channels.fetch(forumId);
  if (!ch) throw new Error('FORUM_CHANNEL_ID: channel not found');
  if (ch.type !== ChannelType.GuildForum) throw new Error('FORUM_CHANNEL_ID is not a forum channel');
  return ch;
}

async function fetchTimerChannel(guild) {
  const timerId = mustEnv('TIMER_CHANNEL_ID');
  const ch = await guild.channels.fetch(timerId);
  if (!ch) throw new Error('TIMER_CHANNEL_ID: channel not found');
  if (!ch.isTextBased()) throw new Error('TIMER_CHANNEL_ID must be a text-based channel');
  return ch;
}

async function fetchThread(guild) {
  const s = getSession();
  if (!s?.threadId) return null;
  return guild.channels.fetch(s.threadId).catch(() => null);
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

// --- formatting ---
function formatMinutes(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h > 0) return `${h}時間${r}分`;
  return `${m}分`;
}
function formatRemaining(ms) {
  const mins = Math.max(0, Math.ceil(ms / 60000));
  return `${mins}分`;
}
function phaseLabel(phase) {
  if (phase === 'focus') return '集中';
  if (phase === 'shortBreak') return '休憩';
  if (phase === 'longBreak') return '長休憩';
  if (phase === 'paused') return '一時停止';
  if (phase === 'done') return '終了';
  return '準備中';
}

module.exports = {
  mustEnv,
  jstDateString,
  safeName,
  getSession,
  ensureSession,
  setSession,
  clearSession,

  isControlAllowed,
  clearAllTimers,

  ensureParticipant,
  joinParticipant,
  leaveParticipant,
  finalizeAllParticipants,
  getParticipantActiveMsNow,

  setGoal,
  setResult,

  fetchForumChannel,
  fetchTimerChannel,
  fetchThread,
  getNextIndexForPrefix,

  formatMinutes,
  formatRemaining,
  phaseLabel,
};
