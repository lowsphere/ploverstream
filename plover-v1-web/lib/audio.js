"use strict";
// Tab audio. CDP has no way to capture what a page plays, and a headless
// Chromium plays it nowhere a server could record (it is launched muted), so a
// script injected into every document taps the sound where the page makes it:
//
//   Web Audio   any node connected to an AudioContext's destination is also
//               connected to a tap in that context
//   <audio>, <video>   once played, captureStream() feeds a tap in a context of
//               the script's own. Media whose data is cross-origin without CORS
//               refuses capture, and stays silent for the viewer.
//
// A tap is a ScriptProcessorNode (an AudioWorklet module would need a URL the
// page's CSP may forbid). Each block it hears is posted as 16-bit stereo PCM
// through a CDP binding, "tap,rate,base64"; silent blocks are not posted.
// Frames running in their own process (cross-site iframes) are not reached.

const BINDING = "__ploverAudio";
const BLOCK = 2048;                  // frames per post: ~43 ms at 48 kHz

// Runs in the page, before its own scripts. It keeps the binding to itself and
// leaves the page's audio exactly as it was; the taps only listen.
function pageHook(binding, block) {
  var send = window[binding];
  if (typeof send !== "function") return;
  try { delete window[binding]; } catch (e) {}
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !window.AudioNode || !window.AudioDestinationNode) return;
  var connect = AudioNode.prototype.connect, disconnect = AudioNode.prototype.disconnect;
  var taps = new WeakMap(), hooked = new WeakSet(), seq = 0, own = null;

  function makeTap(ctx) {
    var id = ++seq, node = ctx.createScriptProcessor(block, 2, 2);
    node.channelCount = 2; node.channelCountMode = "explicit"; node.channelInterpretation = "speakers";
    node.onaudioprocess = function (e) {
      var l = e.inputBuffer.getChannelData(0), r = e.inputBuffer.getChannelData(1), n = l.length;
      var pcm = new Int16Array(n * 2), loud = 0;
      for (var i = 0; i < n; i++) {
        var a = l[i], b = r[i];
        a = a > 1 ? 1 : a < -1 ? -1 : a; b = b > 1 ? 1 : b < -1 ? -1 : b;
        loud |= (pcm[2 * i] = a * 32767) | (pcm[2 * i + 1] = b * 32767);
      }
      if (!loud) return;
      var bytes = new Uint8Array(pcm.buffer), s = "";
      for (var j = 0; j < bytes.length; j += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
      send(id + "," + ctx.sampleRate + "," + btoa(s));
    };
    // A processor only runs while connected onward; its output stays silent.
    connect.call(node, ctx.destination);
    return node;
  }

  function tapFor(ctx) {
    var t = taps.get(ctx);
    if (t === undefined) {
      t = null;
      try { if (!(window.OfflineAudioContext && ctx instanceof OfflineAudioContext)) t = makeTap(ctx); } catch (e) {}
      taps.set(ctx, t);
    }
    return t;
  }

  AudioNode.prototype.connect = function (dest) {
    var r = connect.apply(this, arguments);
    if (dest instanceof AudioDestinationNode) {
      var t = tapFor(this.context);
      if (t && t !== this) try { connect.call(this, t, arguments[1] || 0); } catch (e) {}
    }
    return r;
  };
  AudioNode.prototype.disconnect = function (dest) {
    if (dest instanceof AudioDestinationNode) {
      var t = taps.get(this.context);
      if (t) try { disconnect.call(this, t); } catch (e) {}
    }
    return disconnect.apply(this, arguments);
  };

  // The context media is captured into. Created on a play(), which usually
  // follows a user gesture; if it still starts suspended, later plays and
  // volume changes try again.
  function ownCtx() {
    if (!own) { own = new AC({ latencyHint: "playback" }); own.tap = makeTap(own); }
    if (own.state === "suspended") own.resume().catch(function () {});
    return own;
  }

  function hookMedia(el) {
    if (hooked.has(el)) { if (own) ownCtx(); return; }
    if (typeof el.captureStream !== "function") return;
    var stream;
    try { stream = el.captureStream(); } catch (e) { return; }     // cross-origin data
    hooked.add(el);
    var ctx = ownCtx(), gain = ctx.createGain(), seen = new WeakSet();
    // Captured audio ignores the element's own volume and mute.
    function level() { gain.gain.value = el.muted ? 0 : el.volume; ownCtx(); }
    function add(track) {
      if (seen.has(track)) return;
      seen.add(track);
      if (track.kind !== "audio") { track.stop(); return; }         // nobody needs the video copy
      try { connect.call(ctx.createMediaStreamSource(new MediaStream([track])), gain); } catch (e) {}
    }
    level();
    el.addEventListener("volumechange", level);
    connect.call(gain, ctx.tap);
    stream.getTracks().forEach(add);
    stream.addEventListener("addtrack", function (e) { add(e.track); });
  }

  var play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try { hookMedia(this); } catch (e) {}
    return play.apply(this, arguments);
  };
  // Autoplay and native controls start playback without calling play().
  window.addEventListener("play", function (e) {
    if (e.target instanceof HTMLMediaElement) try { hookMedia(e.target); } catch (x) {}
  }, true);
}

const SCRIPT = "(" + pageHook + ")(" + JSON.stringify(BINDING) + "," + BLOCK + ")";

// Install the hook in a tab: the binding first, so the script finds it in
// every document from the next one on, and in the current one too.
async function installAudio(cdp) {
  await cdp.send("Runtime.enable");
  await cdp.send("Runtime.addBinding", { name: BINDING });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SCRIPT, runImmediately: true });
}

const POST = /^(\d{1,6}),(\d{4,6}),([A-Za-z0-9+/]+={0,2})$/;
const MAX_POST = Math.ceil(BLOCK * 4 / 3) * 4 + 32;

// A binding call is page input like any other: anything malformed is ignored.
// Returns {tap, rate, pcm} with pcm as interleaved stereo int16 LE, or null.
function parsePost(payload) {
  if (typeof payload !== "string" || payload.length > MAX_POST) return null;
  const m = POST.exec(payload);
  if (!m) return null;
  const rate = Number(m[2]);
  if (rate < 8000 || rate > 192000) return null;
  const pcm = Buffer.from(m[3], "base64");
  if (!pcm.length || pcm.length % 4) return null;
  return { tap: Number(m[1]), rate, pcm };
}

module.exports = { BINDING, installAudio, parsePost };
