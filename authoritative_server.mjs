#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { ALL_WORDS, WORD_PACKS } from './words.mjs';

const MARKER = 'doodle-duel-v1';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 10000);
const STATIC_ROOT = resolve(process.env.STATIC_ROOT || join(dirname(fileURLToPath(import.meta.url)), '../dist'));
const MAX_PLAYERS = 12;
const MAX_ROOM_SIZE = 12;
const ROOM_IDLE_MS = 30 * 60_000;
const RECONNECT_GRACE_MS = 60_000;
const MAX_MESSAGE = 32_000;
const MAX_DRAW_OPS = 2_500;
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
const PROFANITY = new Set(['fuck','shit','bitch','asshole','bastard','dick','cunt']);
const AVATARS = ['🦊','🐸','🐼','🐙','🦄','🐯','🐨','🐳','🦋','🐝','🐲','🐧'];
const BOT_NAMES = ['DoodleBot','Sketchy','Pixel Pal','Inkling','CrayonBot','Scribble'];
const SEAT_IDS = Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i + 1}`);

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('Invalid PORT');

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.ttf', 'font/ttf'], ['.woff2', 'font/woff2']
]);
const rooms = new Map();

const finite = n => typeof n === 'number' && Number.isFinite(n);
const id = () => randomBytes(9).toString('base64url');
const code = () => randomBytes(4).toString('hex').toUpperCase();
const now = () => Date.now();
const cleanText = (value, max = 32) => String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
const cleanName = value => cleanText(value, 18).replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'Player';
const cleanRoom = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const censor = value => cleanText(value, 180).split(/(\s+)/).map(part => PROFANITY.has(part.toLowerCase()) ? '•••' : part).join('');
const pick = array => array[Math.floor(Math.random() * array.length)];
const shuffle = array => [...array].sort(() => Math.random() - 0.5);
const send = (ws, payload) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
const broadcast = (room, payload) => room.clients.forEach(ws => send(ws, payload));
const broadcastState = room => room.clients.forEach(ws => send(ws, room.stateFor(ws.player)));

function allowOrigin(req) {
  if (!req.headers.origin) return true;
  if (ALLOWED_ORIGINS.size === 0) return true;
  return ALLOWED_ORIGINS.has(req.headers.origin);
}

function packWords(settings) {
  const requested = settings.theme && WORD_PACKS[settings.theme] ? WORD_PACKS[settings.theme] : ALL_WORDS;
  return requested.filter(word => settings.difficulty === 'easy' ? word.length <= 12 : settings.difficulty === 'hard' ? word.length >= 8 : true);
}

function maskWord(answer, revealed) {
  return [...answer].map((char, index) => char === ' ' ? '  ' : revealed.has(index) ? char.toUpperCase() : '_').join(' ');
}

function wordChoices(answerPool) {
  return shuffle(answerPool).slice(0, 3).map((word, index) => ({ id: `${index}-${word}`, word }));
}

class Room {
  constructor(roomCode) {
    this.code = roomCode;
    this.clients = new Set();
    this.players = new Map();
    this.hostId = '';
    this.settings = { rounds: 4, drawTime: 75, maxPlayers: 8, difficulty: 'mixed', theme: 'all', chaos: false };
    this.phase = 'lobby';
    this.round = 0;
    this.drawerId = '';
    this.answer = '';
    this.choices = [];
    this.phaseEndsAt = 0;
    this.roundStartedAt = 0;
    this.revealed = new Set();
    this.nextRevealAt = 0;
    this.guessed = new Set();
    this.canvasOps = [];
    this.canvasRevision = 0;
    this.roundMessage = 'Pick a room and start doodling.';
    this.lastActivity = now();
    this.hostTimer = null;
    this.botChoiceTimer = null;
    this.botDrawTimer = null;
    this.botGuessTimers = new Set();
  }

  add(ws, payload) {
    const wantedId = cleanText(payload.resumeId, 80);
    const existing = wantedId ? [...this.players.values()].find(player => player.id === wantedId && player.disconnectedAt && now() - player.disconnectedAt < RECONNECT_GRACE_MS) : undefined;
    if (this.players.size >= Math.min(this.settings.maxPlayers, MAX_ROOM_SIZE) && !existing) return send(ws, { type: 'error', code: 'room_full', message: 'This room is full.' });
    const player = existing || { id: id(), seat: `p${this.players.size + 1}`, name: cleanName(payload.nickname), avatar: AVATARS.includes(payload.avatar) ? payload.avatar : pick(AVATARS), score: 0, streak: 0, powerups: {}, connected: true, disconnectedAt: 0, guessed: false, ws };
    player.name = cleanName(payload.nickname || player.name);
    player.avatar = AVATARS.includes(payload.avatar) ? payload.avatar : player.avatar;
    player.connected = true; player.disconnectedAt = 0; player.ws = ws;
    if (!existing) this.players.set(player.id, player);
    ws.room = this; ws.player = player; this.clients.add(ws);
    if (!this.hostId) this.hostId = player.id;
    if (this.phase === 'drawing' || this.phase === 'choosing') player.joinedRound = this.round;
    this.lastActivity = now();
    send(ws, { type: 'welcome', marker: MARKER, room: this.code, playerId: player.id, resumeId: player.id, hostId: this.hostId, avatars: AVATARS });
    send(ws, { type: 'canvas_snapshot', revision: this.canvasRevision, ops: this.canvasOps });
    this.sendPrivateRound(player);
    broadcastState(this);
  }

  remove(ws) {
    const player = ws.player;
    this.clients.delete(ws);
    if (!player) return;
    player.connected = false; player.disconnectedAt = now(); player.ws = null;
    if (this.hostId === player.id) this.hostId = [...this.players.values()].find(p => p.connected)?.id || '';
    if (this.phase !== 'lobby' && player.id === this.drawerId) this.endRound('The drawer disconnected.');
    this.lastActivity = now();
    broadcastState(this);
  }

  settingsUpdate(player, input) {
    if (this.phase !== 'lobby' || player.id !== this.hostId) return;
    this.settings = {
      rounds: Math.min(10, Math.max(2, Number(input.rounds) || 4)),
      drawTime: Math.min(120, Math.max(30, Number(input.drawTime) || 75)),
      maxPlayers: Math.min(MAX_ROOM_SIZE, Math.max(2, Number(input.maxPlayers) || 8)),
      difficulty: ['easy','mixed','hard'].includes(input.difficulty) ? input.difficulty : 'mixed',
      theme: ['all', ...Object.keys(WORD_PACKS)].includes(input.theme) ? input.theme : 'all',
      chaos: Boolean(input.chaos),
    };
    broadcastState(this);
  }

  addBot(player) {
    if (player.id !== this.hostId || this.phase !== 'lobby' || this.players.size >= Math.min(this.settings.maxPlayers, MAX_ROOM_SIZE)) return;
    const usedNames = new Set([...this.players.values()].map(p => p.name));
    const base = BOT_NAMES.find(name => !usedNames.has(name)) || `Bot ${this.players.size}`;
    const bot = { id: `bot-${id()}`, seat: `p${this.players.size + 1}`, name: base, avatar: AVATARS[this.players.size % AVATARS.length], score: 0, streak: 0, powerups: {}, connected: true, disconnectedAt: 0, ws: null, isBot: true, guessed: false };
    this.players.set(bot.id, bot);
    this.lastActivity = now();
    broadcastState(this);
  }

  start(player) {
    if (player.id !== this.hostId || this.phase !== 'lobby' || [...this.players.values()].filter(p => p.connected).length < 2) return;
    this.round = 0; this.players.forEach(p => { p.score = 0; p.streak = 0; });
    this.startRound();
  }

  startRound() {
    const active = [...this.players.values()].filter(p => p.connected);
    if (active.length < 2) { this.phase = 'lobby'; this.roundMessage = 'Need at least two connected players.'; broadcastState(this); return; }
    this.clearBotTimers();
    this.round += 1;
    if (this.round > this.settings.rounds) return this.finish();
    this.drawerId = active[(this.round - 1) % active.length].id;
    this.answer = ''; this.choices = wordChoices(packWords(this.settings)); this.guessed = new Set(); this.revealed = new Set(); this.canvasOps = []; this.canvasRevision += 1;
    this.players.forEach(p => { p.guessed = false; p.powerups = {}; p.joinedRound = this.round; });
    this.phase = 'choosing'; this.phaseEndsAt = now() + 10_000; this.roundStartedAt = now(); this.roundMessage = `${this.getPlayer(this.drawerId)?.name || 'The drawer'} is choosing a word…`;
    broadcast(this, { type: 'canvas_snapshot', revision: this.canvasRevision, ops: [] });
    broadcastState(this); this.sendPrivateRound(this.getPlayer(this.drawerId));
    const drawer = this.getPlayer(this.drawerId);
    if (drawer?.isBot) this.botChoiceTimer = setTimeout(() => this.chooseWord(drawer, this.choices[0]?.id || ''), 900);
  }

  chooseWord(player, choiceId) {
    if (this.phase !== 'choosing' || player.id !== this.drawerId) return;
    const picked = this.choices.find(choice => choice.id === choiceId) || this.choices[0];
    this.answer = picked.word; this.phase = 'drawing'; this.roundStartedAt = now(); this.phaseEndsAt = now() + this.settings.drawTime * 1000; this.nextRevealAt = now() + Math.max(12_000, this.settings.drawTime * 200); this.roundMessage = `${player.name} is drawing. Guess the word!`;
    broadcastState(this); this.sendPrivateRound(player);
    if (player.isBot) this.startBotDrawing(player);
    else this.scheduleBotGuesses();
  }

  startBotDrawing(bot) {
    let step = 0;
    let previous = { x: 0.18, y: 0.28 };
    const palette = ['#ff4f81', '#ffc94d', '#22bfa4', '#7565f5'];
    this.botDrawTimer = setInterval(() => {
      if (this.phase !== 'drawing' || this.drawerId !== bot.id) return this.clearBotTimers();
      const progress = (step % 24) / 23;
      const point = { x: 0.18 + progress * 0.64, y: 0.28 + Math.sin(progress * Math.PI * 2) * 0.16 };
      const kind = step % 6 === 0 ? 'start' : step % 6 === 5 ? 'end' : 'move';
      this.draw(bot, { kind, x: point.x, y: point.y, px: previous.x, py: previous.y, color: palette[Math.floor(step / 6) % palette.length], size: 8, tool: 'brush' });
      previous = point; step += 1;
      if (step > 47) this.clearBotTimers();
    }, 120);
  }

  scheduleBotGuesses() {
    for (const bot of this.players.values()) {
      if (!bot.isBot || bot.id === this.drawerId) continue;
      const timer = setTimeout(() => { this.botGuessTimers.delete(timer); if (this.phase === 'drawing') this.guess(bot, this.answer); }, 1800 + Math.floor(Math.random() * 1400));
      this.botGuessTimers.add(timer);
    }
  }

  clearBotTimers() {
    if (this.botChoiceTimer) clearTimeout(this.botChoiceTimer);
    if (this.botDrawTimer) clearInterval(this.botDrawTimer);
    this.botChoiceTimer = null; this.botDrawTimer = null;
    for (const timer of this.botGuessTimers) clearTimeout(timer);
    this.botGuessTimers.clear();
  }

  tick() {
    if (this.phase === 'choosing' && now() >= this.phaseEndsAt) this.chooseWord(this.getPlayer(this.drawerId), this.choices[0]?.id || '');
    if (this.phase === 'drawing') {
      if (now() >= this.nextRevealAt && this.revealed.size < this.answer.replaceAll(' ', '').length) { this.revealLetter(); this.nextRevealAt = now() + Math.max(8_000, this.settings.drawTime * 180); }
      if (now() >= this.phaseEndsAt) this.endRound('Time is up!');
    }
    if (this.phase === 'round_end' && now() >= this.phaseEndsAt) this.startRound();
    if (this.phase === 'finished' && now() >= this.phaseEndsAt) { this.phase = 'lobby'; this.roundMessage = 'Play again when you are ready.'; broadcastState(this); }
  }

  revealLetter() {
    const hidden = [...this.answer].map((char, i) => char !== ' ' && !this.revealed.has(i) ? i : -1).filter(i => i >= 0);
    if (hidden.length) this.revealed.add(pick(hidden));
    broadcastState(this);
  }

  guess(player, rawText) {
    if (this.phase !== 'drawing' || player.id === this.drawerId || player.guessed || !player.connected) return;
    const text = censor(rawText);
    if (!text) return;
    const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = this.answer.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized === target) {
      player.guessed = true; this.guessed.add(player.id); player.streak += 1;
      const remaining = Math.max(0, this.phaseEndsAt - now());
      const base = Math.round(100 + 900 * (remaining / (this.settings.drawTime * 1000)));
      const streakBonus = Math.min(300, player.streak * 50);
      const doubled = player.powerups.doublePoints === true;
      const earned = (base + streakBonus) * (doubled ? 2 : 1);
      player.score += earned;
      const drawer = this.getPlayer(this.drawerId); if (drawer) drawer.score += 75;
      const reward = pick(['reveal', 'double', 'freeze', 'shield']);
      player.powerups[reward] = true;
      player.powerups = { ...player.powerups, double: false, [reward]: true };
      if (this.guessed.size >= this.players.size - 1) this.endRound('Everyone guessed it!');
      else { this.roundMessage = `${player.name} guessed it!`; broadcastState(this); }
      send(player.ws, { type: 'private_notice', tone: 'success', text: `Correct! +${earned} points`, earned });
      return;
    }
    if (levenshtein(normalized, target) <= 2 || (normalized.length > 3 && target.startsWith(normalized))) send(player.ws, { type: 'private_notice', tone: 'close', text: "You're close!" });
    this.chat(player, text);
  }

  chat(player, text) {
    if (!player.connected || player.guessed) return;
    const safe = censor(text); if (!safe) return;
    broadcast(this, { type: 'chat', id: player.id, name: player.name, avatar: player.avatar, text: safe, at: now() });
  }

  draw(player, op) {
    if (this.phase !== 'drawing' || player.id !== this.drawerId) return;
    const kind = cleanText(op.kind, 10); if (!['start','move','end'].includes(kind)) return;
    const x = Number(op.x), y = Number(op.y), size = Math.min(40, Math.max(1, Number(op.size) || 6));
    if (![x, y].every(v => Number.isFinite(v)) || x < 0 || x > 1 || y < 0 || y > 1) return;
    const safeOp = { kind, x, y, px: Number(op.px) || x, py: Number(op.py) || y, color: cleanText(op.color, 16) || '#ff4f81', size, tool: op.tool === 'eraser' ? 'eraser' : 'brush' };
    this.canvasOps.push(safeOp); if (this.canvasOps.length > MAX_DRAW_OPS) this.canvasOps.shift(); this.canvasRevision += 1;
    this.clients.forEach(ws => { if (ws !== player.ws) send(ws, { type: 'draw', revision: this.canvasRevision, op: safeOp }); });
  }

  canvasAction(player, action) {
    if (this.phase !== 'drawing' || player.id !== this.drawerId) return;
    if (!['clear','undo','fill'].includes(action)) return;
    if (action === 'clear') this.canvasOps = [];
    if (action === 'undo') this.canvasOps = this.canvasOps.slice(0, -8);
    this.canvasRevision += 1;
    broadcast(this, { type: 'canvas_action', revision: this.canvasRevision, action });
  }

  usePowerup(player, powerup) {
    if (this.phase !== 'drawing' || !player.connected || player.guessed || !['reveal','double','freeze','shield'].includes(powerup) || !player.powerups[powerup]) return;
    player.powerups[powerup] = false;
    if (powerup === 'reveal') this.revealLetter();
    if (powerup === 'double') player.powerups.double = true;
    if (powerup === 'freeze') this.phaseEndsAt += 10_000;
    if (powerup === 'shield') player.powerups.shield = true;
    broadcast(this, { type: 'powerup', id: player.id, powerup }); broadcastState(this);
  }

  reaction(player, emoji) {
    if (!['✨','😂','😮','🔥','👏','💡','🤔','🎉'].includes(emoji)) return;
    broadcast(this, { type: 'reaction', id: player.id, avatar: player.avatar, emoji });
  }

  shake(player) {
    if (this.phase === 'drawing' && player.id === this.drawerId) broadcast(this, { type: 'shake', id: player.id });
  }

  kick(player, targetId) {
    if (player.id !== this.hostId || !this.players.has(targetId) || targetId === this.hostId) return;
    const target = this.players.get(targetId); if (!target) return;
    send(target.ws, { type: 'kicked', message: 'You were removed from the room by the host.' }); target.ws?.close(4003, 'kicked');
    this.players.delete(targetId); broadcastState(this);
  }

  report(player, targetId) {
    const target = this.players.get(targetId); if (target) console.log(JSON.stringify({ event: 'report', room: this.code, from: player.name, target: target.name, at: now() }));
    send(player.ws, { type: 'private_notice', tone: 'info', text: 'Report received. Thanks for keeping Doodle Duel friendly.' });
  }

  endRound(message) {
    if (!['drawing','choosing'].includes(this.phase)) return;
    this.clearBotTimers();
    this.phase = 'round_end'; this.phaseEndsAt = now() + 4_500; this.roundMessage = message; this.players.forEach(p => { if (p.id !== this.drawerId && !p.guessed) p.streak = 0; });
    broadcastState(this); broadcast(this, { type: 'round_result', answer: this.answer, message });
  }

  finish() {
    this.clearBotTimers();
    this.phase = 'finished'; this.phaseEndsAt = now() + 30_000; this.roundMessage = 'Great game! Here is the final podium.'; broadcastState(this);
  }

  playAgain(player) {
    if (player.id !== this.hostId || this.phase !== 'finished') return;
    this.players.forEach(p => { p.score = 0; p.streak = 0; }); this.round = 0; this.phase = 'lobby'; this.roundMessage = 'New match ready. Start when everyone is in.'; broadcastState(this);
  }

  getPlayer(idValue) { return idValue ? this.players.get(idValue) : undefined; }

  sendPrivateRound(player) {
    if (!player?.ws) return;
    send(player.ws, { type: 'round_private', phase: this.phase, drawerId: this.drawerId, answer: player.id === this.drawerId ? this.answer : '', choices: player.id === this.drawerId && this.phase === 'choosing' ? this.choices : [], powerups: player.powerups || {} });
  }

  stateFor(viewer) {
    const left = this.phaseEndsAt ? Math.max(0, this.phaseEndsAt - now()) : 0;
    const players = [...this.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, streak: p.streak, connected: p.connected, guessed: p.guessed, isBot: Boolean(p.isBot), isDrawer: p.id === this.drawerId, isHost: p.id === this.hostId, powerups: viewer?.id === p.id ? p.powerups : undefined }));
    return { type: 'state', marker: MARKER, room: this.code, hostId: this.hostId, phase: this.phase, round: this.round, rounds: this.settings.rounds, drawerId: this.drawerId, hint: this.answer ? maskWord(this.answer, this.revealed) : '', timeLeft: left, settings: this.settings, players, message: this.roundMessage, viewerId: viewer?.id || '', canvasRevision: this.canvasRevision, podium: this.phase === 'finished' ? players.sort((a,b) => b.score - a.score).map((p, i) => ({ ...p, rank: i + 1 })) : [] };
  }
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) { let previous = row[0]; row[0] = i; for (let j = 1; j <= b.length; j += 1) { const next = row[j]; row[j] = a[i - 1] === b[j - 1] ? previous : 1 + Math.min(previous, row[j - 1], next); previous = next; } }
  return row[b.length];
}

function findOrCreateRoom(requested) {
  let roomCode = cleanRoom(requested);
  if (!roomCode) { do roomCode = code(); while (rooms.has(roomCode)); }
  if (!rooms.has(roomCode)) rooms.set(roomCode, new Room(roomCode));
  return rooms.get(roomCode);
}

function onMessage(ws, raw) {
  if (raw.length > MAX_MESSAGE) return;
  let input; try { input = JSON.parse(raw); } catch { return send(ws, { type: 'error', code: 'invalid_message', message: 'Invalid message.' }); }
  const room = ws.room; const player = ws.player; if (!room || !player || typeof input?.type !== 'string') return;
  room.lastActivity = now();
  switch (input.type) {
    case 'settings': room.settingsUpdate(player, input); break;
    case 'add_bot': room.addBot(player); break;
    case 'start': room.start(player); break;
    case 'choose_word': room.chooseWord(player, cleanText(input.choiceId, 80)); break;
    case 'draw': room.draw(player, input); break;
    case 'canvas': room.canvasAction(player, cleanText(input.action, 10)); break;
    case 'chat': room.guess(player, input.text); break;
    case 'powerup': room.usePowerup(player, cleanText(input.powerup, 16)); break;
    case 'reaction': room.reaction(player, cleanText(input.emoji, 4)); break;
    case 'shake': room.shake(player); break;
    case 'kick': room.kick(player, cleanText(input.targetId, 80)); break;
    case 'report': room.report(player, cleanText(input.targetId, 80)); break;
    case 'play_again': room.playAgain(player); break;
    case 'ping': send(ws, { type: 'pong', t: input.t }); break;
    default: send(ws, { type: 'error', code: 'unknown_message', message: 'Unknown action.' });
  }
}

const server = createServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, service: 'doodle-duel', rooms: rooms.size, marker: MARKER })); return; }
  if (req.url?.startsWith('/ws')) { res.writeHead(426); res.end('WebSocket endpoint'); return; }
  if (!existsSync(STATIC_ROOT)) { res.writeHead(404); res.end('Doodle Duel server is ready.'); return; }
  let pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/') pathname = '/index.html';
  const safePath = normalize(pathname).replace(/^\.\.(\/|\\)/, '');
  const file = resolve(STATIC_ROOT, `.${safePath}`);
  if (!file.startsWith(STATIC_ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  try { const info = await stat(file); if (!info.isFile()) throw new Error('not file'); res.writeHead(200, { 'content-type': mime.get(extname(file)) || 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' }); createReadStream(file).pipe(res); }
  catch { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
server.on('upgrade', (req, socket, head) => {
  if (!allowOrigin(req) || !new URL(req.url || '/', 'http://localhost').pathname.startsWith('/ws')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const room = findOrCreateRoom(url.searchParams.get('room'));
  ws.on('message', data => onMessage(ws, data.toString()));
  ws.on('close', () => { room.remove(ws); });
  ws.on('error', () => { room.remove(ws); });
  ws.once('message', data => {
    let payload; try { payload = JSON.parse(data.toString()); } catch { return; }
    if (payload?.type !== 'join') return send(ws, { type: 'error', code: 'join_required', message: 'Join payload required.' });
    room.add(ws, payload);
  });
});

setInterval(() => {
  const current = now();
  for (const [roomCode, room] of rooms) { room.tick(); if (room.clients.size === 0 && current - room.lastActivity > ROOM_IDLE_MS) rooms.delete(roomCode); }
}, 250);
server.listen(PORT, HOST, () => console.log(JSON.stringify({ port: server.address().port, host: HOST, marker: MARKER })));
