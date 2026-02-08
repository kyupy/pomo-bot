const { ensureSession, clearAllTimers } = require('./state');
const { renderTimer } = require('./ui_timer');
const { logThread } = require('./ui_thread');

function ms(min) { return min * 60 * 1000; }

function startMinuteTick(timerChannel) {
  const s = ensureSession();
  const interval = setInterval(async () => {
    await renderTimer(timerChannel);
  }, 60 * 1000);
  s.intervals.push(interval);
  return interval;
}

async function startFocus(thread, timerChannel, { resume = false } = {}) {
  const s = ensureSession();

  if (!resume) s.sliceSeq += 1;
  s.phase = 'focus';

  const durationMs = s.currentPhaseRemainingMs ?? ms(s.sliceMin);
  s.currentPhaseRemainingMs = null;
  s.currentPhaseEndsAtMs = Date.now() + durationMs;

  await logThread(thread, `▶️ 集中開始（通し#${s.sliceSeq} / ${s.sliceMin}分）`);
  await renderTimer(timerChannel);

  const tick = startMinuteTick(timerChannel);
  const timeout = setTimeout(async () => {
    clearInterval(tick);
    await onFocusEnd(thread, timerChannel, s.sliceSeq);
  }, durationMs);

  s.timeouts.push(timeout);
}

async function onFocusEnd(thread, timerChannel, sliceSeq) {
  const s = ensureSession();
  if (s.phase !== 'focus') return;
  if (sliceSeq !== s.sliceSeq) return;

  await logThread(thread, `⏱️ 集中終了（通し#${sliceSeq}）`);
  // 完了スライスとしてストックに乗るよう、ここで即描画
  await renderTimer(timerChannel);

  const isLast = (s.sliceInPomodoro >= s.slicesPerPomodoro);
  if (isLast) {
    s.phase = 'longBreak';
    await logThread(thread, `## ポモ#${s.pomodoroIndex} 終了 → 長休憩へ`);
  } else {
    s.phase = 'shortBreak';
    await logThread(thread, `休憩へ（次：スライス${s.sliceInPomodoro + 1}/${s.slicesPerPomodoro}）`);
  }

  await startBreak(thread, timerChannel, { wasLongBreak: isLast });
}

async function startBreak(thread, timerChannel, { wasLongBreak }) {
  const s = ensureSession();
  s.phase = wasLongBreak ? 'longBreak' : 'shortBreak';

  const breakMin = wasLongBreak ? s.longBreakMin : s.shortBreakMin;
  const durationMs = s.currentPhaseRemainingMs ?? ms(breakMin);
  s.currentPhaseRemainingMs = null;
  s.currentPhaseEndsAtMs = Date.now() + durationMs;

  await renderTimer(timerChannel);

  const tick = startMinuteTick(timerChannel);
  const timeout = setTimeout(async () => {
    clearInterval(tick);
    await onBreakEnd(thread, timerChannel, { wasLongBreak, sliceSeq: s.sliceSeq });
  }, durationMs);

  s.timeouts.push(timeout);
}

async function onBreakEnd(thread, timerChannel, { wasLongBreak, sliceSeq }) {
  const s = ensureSession();
  if (sliceSeq !== s.sliceSeq) return;

  await logThread(thread, `⏱️ 休憩終了（通し#${sliceSeq}）`);

  if (wasLongBreak) {
    s.pomodoroIndex += 1;
    s.sliceInPomodoro = 1;
    await logThread(thread, `## ポモ#${s.pomodoroIndex} 開始`);
  } else {
    s.sliceInPomodoro += 1;
  }

  await startFocus(thread, timerChannel, { resume: false });
}

async function pauseTimer(thread, timerChannel) {
  const s = ensureSession();
  clearAllTimers();

  s.pauseStartedAtMs = Date.now();
  s.pausedFrom = s.phase;
  s.phase = 'paused';

  const now = Date.now();
  s.currentPhaseRemainingMs = s.currentPhaseEndsAtMs ? Math.max(0, s.currentPhaseEndsAtMs - now) : 0;

  await logThread(thread, '⏸️ 一時停止しました。/pomo resume で再開できます。');
  await renderTimer(timerChannel);
}

async function resumeTimer(thread, timerChannel) {
  const s = ensureSession();
  if (s.phase !== 'paused') return;

  clearAllTimers();

  const now = Date.now();
  if (s.pauseStartedAtMs) {
    s.pausedMsAccum += (now - s.pauseStartedAtMs);
    s.pauseStartedAtMs = null;
  }

  const from = s.pausedFrom;
  s.pausedFrom = null;

  if (from === 'focus') {
    await logThread(thread, `▶️ 再開：集中（通し#${s.sliceSeq}）`);
    return await startFocus(thread, timerChannel, { resume: true });
  }
  if (from === 'shortBreak' || from === 'longBreak') {
    await logThread(thread, `▶️ 再開：休憩（通し#${s.sliceSeq}）`);
    return await startBreak(thread, timerChannel, { wasLongBreak: from === 'longBreak' });
  }

  await logThread(thread, '▶️ 再開：集中');
  return await startFocus(thread, timerChannel, { resume: false });
}

module.exports = { startFocus, pauseTimer, resumeTimer };
