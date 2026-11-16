const stopTimers = new Map();

function setLiveReplayStopTimer(replayId, timer) {
  if (!replayId || !timer) return;
  stopTimers.set(replayId, timer);
}

function clearLiveReplayStop(replayId) {
  const timer = stopTimers.get(replayId);
  if (timer) clearTimeout(timer);
  stopTimers.delete(replayId);
}

module.exports = { setLiveReplayStopTimer, clearLiveReplayStop };
