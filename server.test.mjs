import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

let processHandle;
let port;

function packet(ws, predicate, timeout = 4000) {
  const history = ws.__history || [];
  const existing = history.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('packet timeout')); }, timeout);
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      history.push(message);
      if (!predicate(message)) return;
      clearTimeout(timer); ws.off('message', onMessage); resolve(message);
    };
    ws.on('message', onMessage);
  });
}

function player(room, nickname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`);
    ws.__history = [];
    ws.on('message', raw => ws.__history.push(JSON.parse(raw.toString())));
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'join', nickname, avatar: nickname === 'A' ? '🦊' : '🐼' })));
    packet(ws, message => message.type === 'welcome').then(welcome => resolve({ ws, welcome })).catch(reject);
  });
}

test.before(async () => {
  processHandle = spawn(process.execPath, ['authoritative_server.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((resolve, reject) => { let buffer = ''; const timer = setTimeout(() => reject(new Error('server start timeout')), 5000); processHandle.stdout.on('data', chunk => { buffer += chunk.toString(); const first = buffer.split('\n')[0]; try { const data = JSON.parse(first); clearTimeout(timer); resolve(data); } catch {} }); processHandle.once('error', reject); });
  port = line.port;
});

test.after(() => processHandle?.kill('SIGTERM'));

test('two players join, start a round, choose a word, and relay drawing', async () => {
  const a = await player('ROOMA', 'A');
  const b = await player('ROOMA', 'B');
  const state = await packet(a.ws, message => message.type === 'state' && message.players.length === 2);
  assert.equal(state.phase, 'lobby');
  a.ws.send(JSON.stringify({ type: 'start' }));
  const choosing = await packet(a.ws, message => message.type === 'state' && message.phase === 'choosing');
  const drawer = choosing.drawerId === a.welcome.playerId ? a : b;
  const guesser = drawer === a ? b : a;
  const privateRound = await packet(drawer.ws, message => message.type === 'round_private' && message.choices.length === 3);
  drawer.ws.send(JSON.stringify({ type: 'choose_word', choiceId: privateRound.choices[0].id }));
  await packet(guesser.ws, message => message.type === 'state' && message.phase === 'drawing');
  drawer.ws.send(JSON.stringify({ type: 'draw', kind: 'start', x: 0.2, y: 0.2, px: 0.2, py: 0.2, color: '#ff4f81', size: 8, tool: 'brush' }));
  const relay = await packet(guesser.ws, message => message.type === 'draw');
  assert.equal(relay.op.color, '#ff4f81');
  drawer.ws.close(); guesser.ws.close();
});

test('correct guesses award points without broadcasting the answer in chat', async () => {
  const a = await player('ROOMB', 'A');
  const b = await player('ROOMB', 'B');
  await packet(a.ws, message => message.type === 'state' && message.players.length === 2);
  a.ws.send(JSON.stringify({ type: 'start' }));
  const choosing = await packet(a.ws, message => message.type === 'state' && message.phase === 'choosing');
  const drawer = choosing.drawerId === a.welcome.playerId ? a : b;
  const guesser = drawer === a ? b : a;
  const privateRound = await packet(drawer.ws, message => message.type === 'round_private' && message.choices.length === 3);
  const answer = privateRound.choices[0]; drawer.ws.send(JSON.stringify({ type: 'choose_word', choiceId: answer.id }));
  await packet(guesser.ws, message => message.type === 'state' && message.phase === 'drawing');
  guesser.ws.send(JSON.stringify({ type: 'chat', text: answer.word }));
  const notice = await packet(guesser.ws, message => message.type === 'private_notice' && message.tone === 'success');
  assert.match(notice.text, /Correct/);
  const scoreState = await packet(guesser.ws, message => message.type === 'state' && message.players.some(p => p.id === guesser.welcome.playerId && p.score > 0));
  assert.ok(scoreState.players.find(p => p.id === guesser.welcome.playerId).score > 0);
  drawer.ws.close(); guesser.ws.close();
});

test('health endpoint reports the Doodle Duel protocol marker', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.marker, 'doodle-duel-v1');
});


test('host can add a bot and the bot takes a real synchronized drawing turn', { timeout: 15000 }, async () => {
  const human = await player('BOTROOM', 'A');
  await packet(human.ws, message => message.type === 'state' && message.players.length === 1);
  human.ws.send(JSON.stringify({ type: 'add_bot' }));
  const lobby = await packet(human.ws, message => message.type === 'state' && message.players.some(p => p.isBot));
  const bot = lobby.players.find(p => p.isBot);
  assert.ok(bot, 'bot should appear in the lobby');
  human.ws.send(JSON.stringify({ type: 'start' }));
  const choosing = await packet(human.ws, message => message.type === 'state' && message.phase === 'choosing');
  assert.equal(choosing.drawerId, human.welcome.playerId, 'human draws first');
  const privateRound = await packet(human.ws, message => message.type === 'round_private' && message.choices.length === 3);
  human.ws.send(JSON.stringify({ type: 'choose_word', choiceId: privateRound.choices[0].id }));
  await packet(human.ws, message => message.type === 'state' && message.phase === 'round_end', 7000);
  const botChoosing = await packet(human.ws, message => message.type === 'state' && message.phase === 'choosing' && message.round === 2, 7000);
  assert.equal(botChoosing.drawerId, bot.id, 'bot should draw on the second round');
  const botDrawing = await packet(human.ws, message => message.type === 'state' && message.phase === 'drawing' && message.round === 2, 3000);
  assert.equal(botDrawing.drawerId, bot.id);
  const botStroke = await packet(human.ws, message => message.type === 'draw', 3000);
  assert.equal(typeof botStroke.op.x, 'number');
  human.ws.close();
});
