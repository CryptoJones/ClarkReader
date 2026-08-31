// Chrome-only entry point. A service worker has no DOM and cannot hold an
// AudioContext, so the shared player lives here and is driven by message.
// Firefox never loads this file — its background page runs the same class directly.

const player = new ClarkPlayer((msg) => {
  // The service worker may be asleep; waking it is the point, but a failed send is
  // not worth an unhandled rejection.
  api.runtime.sendMessage(msg).catch(() => {});
});

api.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "play") {
    player.start(msg.server, msg.job).catch((err) =>
      api.runtime.sendMessage({ type: "cr-playback-error", message: err.message })
        .catch(() => {}));
    return;
  }
  if (msg.type === "control") player.control(msg.action);
});
