"use strict";
// Client key messages carry the DOM `key` and `code`. CDP also wants the
// Windows virtual-key code (pages still read event.keyCode) and, for keys that
// type something, the text to insert.

const VK = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 16, ShiftRight: 16,
  ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20,
  Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 44,
  Insert: 45, Delete: 46, MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110,
  NumpadDivide: 111, NumLock: 144, ScrollLock: 145,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191,
  Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
  IntlBackslash: 226,
};
for (let i = 0; i < 26; i++) VK["Key" + String.fromCharCode(65 + i)] = 65 + i;
for (let i = 0; i < 10; i++) { VK["Digit" + i] = 48 + i; VK["Numpad" + i] = 96 + i; }
for (let i = 1; i <= 24; i++) VK["F" + i] = 111 + i;

// Only used when the client sent no recognisable `code`.
const VK_BY_KEY = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, " ": 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38,
  ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91,
};

function virtualKey(key, code) {
  if (VK[code] !== undefined) return VK[code];
  if (VK_BY_KEY[key] !== undefined) return VK_BY_KEY[key];
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  return 0;
}

function keyLocation(code) {
  if (/^(Shift|Control|Alt|Meta)Left$/.test(code)) return 1;
  if (/^(Shift|Control|Alt|Meta)Right$/.test(code)) return 2;
  if (code.startsWith("Numpad")) return 3;
  return 0;
}

// mods uses the CDP bit layout already: 1 alt, 2 ctrl, 4 meta, 8 shift.
function keyEvent(m) {
  const key = String(m.key || "").slice(0, 32);
  const code = String(m.code || "").slice(0, 32);
  let mods = (m.mods | 0) & 15;
  const down = m.k === "down";
  const vk = virtualKey(key, code);
  let text = "";
  if (down) {
    const printable = [...key].length === 1;
    const ctrl = (mods & 2) !== 0, alt = (mods & 1) !== 0;
    if (key === "Enter" && !ctrl) text = "\r";
    else if (printable && ctrl && alt) { text = key; mods &= ~3; }   // AltGr arrives as Ctrl+Alt
    else if (printable && !ctrl && !(alt && /^[\x20-\x7e]$/.test(key))) text = key;   // Alt+F is a shortcut, Option+f on a Mac is "ƒ"
  }
  const location = keyLocation(code);
  return {
    type: down ? (text ? "keyDown" : "rawKeyDown") : "keyUp",
    modifiers: mods, key, code, text, unmodifiedText: text,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    autoRepeat: !!m.rep, location, isKeypad: location === 3,
  };
}

module.exports = { keyEvent };
