// Cross-browser namespace.
//
// Firefox exposes the promise-based `browser`; Chrome only has `chrome`. Everything
// ClarkReader uses (runtime, tabs, storage, scripting, contextMenus, commands) is
// promise-based on both under MV3, so aliasing is enough and no polyfill is needed.
//
// Loaded as a classic script rather than an ES module because Chrome's service worker
// and Firefox's background scripts disagree about module support; classic scripts are
// the one form both accept without a build step.
const api = globalThis.browser ?? globalThis.chrome;

// Chrome plays audio in an offscreen document because a service worker has no DOM.
// Firefox's background is an event page that does, so it plays in place.
const HAS_OFFSCREEN = typeof api?.offscreen !== "undefined";
