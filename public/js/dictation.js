// Dictation via the browser's Web Speech API (Edge, Chrome, Safari).
// Note: browsers send the audio to their own speech service to transcribe it.

const ERRORS = {
  'not-allowed': 'Microphone access is blocked. Allow it in the browser’s site settings.',
  'service-not-allowed': 'Microphone access is blocked. Allow it in the browser’s site settings.',
  'audio-capture': 'No microphone was found.',
  network: 'Dictation needs an internet connection (the browser’s speech service).',
  'language-not-supported': 'Dictation isn’t available for this language.',
};

/** Split a final transcript into text chunks and "newline" commands. */
export function parseTranscript(text) {
  return text
    .split(/\b(new (?:line|paragraph))\b/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^new (line|paragraph)$/i.test(part) ? { command: 'newline' } : { text: part }));
}

/**
 * @param {{ onState:(listening:boolean)=>void, onInterim:(text:string)=>void,
 *           onFinal:(text:string)=>void, onError:(message:string)=>void }} handlers
 * @returns {null | { toggle():void, start():void, stop():void, readonly listening:boolean }}
 */
export function createDictation({ onState, onInterim, onFinal, onError }) {
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Recognition) return null;

  let rec = null;
  let listening = false;

  function start() {
    if (listening) return;
    rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) onFinal(result[0].transcript);
        else interim += result[0].transcript;
      }
      onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      onError(ERRORS[e.error] ?? `Dictation stopped (${e.error}).`);
      stop();
    };
    // Browsers end a session after a pause; keep going until the user stops.
    rec.onend = () => {
      if (!listening) return;
      try {
        rec.start();
      } catch {
        stop();
      }
    };
    try {
      rec.start();
    } catch (err) {
      onError(`Couldn’t start dictation: ${err.message}`);
      return;
    }
    listening = true;
    onState(true);
  }

  function stop() {
    if (!listening && !rec) return;
    listening = false;
    try {
      rec?.stop();
    } catch {}
    rec = null;
    onInterim('');
    onState(false);
  }

  return {
    start,
    stop,
    toggle: () => (listening ? stop() : start()),
    get listening() {
      return listening;
    },
  };
}
