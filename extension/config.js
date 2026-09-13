// Defaults mirror the server's: bf_emma at 0.88 is CryptoJones's house narration
// voice, the one the OpenCourseWare courses and the Math-for-ML video were read in.
const DEFAULTS = {
  server: "http://127.0.0.1:8756",
  voice: "bf_emma",
  speed: 0.88,
  rsvp: true, // flash each word in the overlay as it is spoken
  maximized: false, // the overlay fills the viewport; toggled from the overlay itself
};

async function getSettings() {
  return { ...DEFAULTS, ...(await api.storage.sync.get(DEFAULTS)) };
}
