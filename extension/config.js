// Defaults mirror the server's: bf_emma at 0.88 is CryptoJones's house narration
// voice, the one the OpenCourseWare courses and the Math-for-ML video were read in.
export const DEFAULTS = {
  server: "http://127.0.0.1:8756",
  voice: "bf_emma",
  speed: 0.88,
  showOverlay: true,
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}
