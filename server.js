// server.js — WebSocket сервер игры 67 v2.1
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const RANKS = ['6','В','Д','К','Т','7','8'];
const SUITS = ['+','☽','♚','☀'];
const RANK_POWER = { '6':0,'В':1,'Д':2,'К':3,'Т':4,'7':5,'8':6 };

// ─── HTTP (health-check) ─────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200); res.end('67 OK');
});
const wss = new WebSocketServer({ server });

// ─── ХРАНИЛИЩЕ ───────────────────────────────────────────────────────────────
// wsInfo: WeakMap<ws, { room, playerIdx }>
const wsInfo = new Map();   // ws → { room, playerIdx }
const rooms  = new Map();   // roomId → Room

function mkRoomId() { return 'R' + Math.floor(1000 + Math.random() * 9000); }

// ─── КОЛОДА ──────────────────────────────────────────────────────────────────
function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  return d;
}
function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── ПРАВИЛА ─────────────────────────────────────────────────────────────────
function canCover(att, def) {
  // Д+ — абсолютная карта, бьёт что угодно
  if (def.rank === 'Д' && def.suit === '+') return true;
  // 7 нельзя перебить шестёркой
  if (att.rank === '7' && def.rank === '6') return false;
  // Масть + кроется ТОЛЬКО мастью + старшим номиналом
  if (att.suit === '+') {
    return def.suit === '+' && RANK_POWER[def.rank] > RANK_POWER[att.rank];
  }
  // Шестёрка — переворот
  if (def.rank === '6') {
    if (att.suit === '+') return false;   // уже обработано выше, но на всякий
    if (att.rank === '7') return false;
    if (def.suit === '♚') return true;   // 6♚ бьёт любую не-+ не-7
    return def.suit === att.suit;         // обычная 6 — только свою масть
  }
  // Козырь (♚) кроется козырем старшим
  if (att.suit === '♚') {
    return def.suit === '♚' && RANK_POWER[def.rank] > RANK_POWER[att.rank];
  }
  // Обычная масть: та же масть старшим ИЛИ козырь
  if (def.suit === att.suit) return RANK_POWER[def.rank] > RANK_POWER[att.rank];
  if (def.suit === '♚') return true;
  return false;
}

// Спецэффект карты при сбросе на стол
function cardEffect(card) {
  // Д+ — абсолют: все карты в биту, переворот, право хода тому кто бросил
  if (card.rank === 'Д' && card.suit === '+') return { flip: true, right: 'thrower', beatAll: true };
  // 8 — переворот, право хода тому кто бросил
  if (card.rank === '8') return { flip: true, right: 'thrower', beatAll: false };
  // 6 — переворот, ход к следующему в новом направлении
  if (card.rank === '6') return { flip: true, right: 'next-reversed', beatAll: false };
  return { flip: false, right: 'next', beatAll: false };
}

function nextIdx(n, from, dir) { return ((from + dir) % n + n) % n; }

// ─── ИНИЦИАЛИЗАЦИЯ ИГРЫ ──────────────────────────────────────────────────────
function initGame(playerCount) {
  const deck = shuffle(buildDeck());
  const hands = Array.from({ length: playerCount }, () => []);
  // Раздаём все 28 карт поровну
  deck.forEach((card, i) => hands[i % playerCount].push(card));

  // Открываем одну рандомную карту — определяем кто ходит первым
  // Берём из полной колоды (до раздачи), находим у кого она в руке
  const allCards = buildDeck();
  const revealCard = allCards[Math.floor(Math.random() * allCards.length)];
  let firstPlayer = 0;
  for (let p = 0; p < playerCount; p++) {
    if (hands[p].some(c => c.rank === revealCard.rank && c.suit === revealCard.suit)) {
      firstPlayer = p; break;
    }
  }

  return {
    hands,
    table: [],
    pile: 0,
    currentPlayer: firstPlayer,
    direction: -1,       // -1 против часовой, +1 по часовой
    phase: 'reveal',     // reveal → playing → gameover
    revealCard,
    firstPlayer,
    loser: null,
    n: playerCount,
    revealConfirmed: 0,  // счётчик подтверждений экрана reveal
  };
}

// ─── ИГРОВАЯ ЛОГИКА ──────────────────────────────────────────────────────────
function tryFlush(state) {
  if (state.table.length >= state.n) {
    state.pile += state.table.length;
    state.table = [];
    return true;
  }
  return false;
}

function checkEnd(state) {
  const alive = state.hands.map((h, i) => ({ i, len: h.length })).filter(x => x.len > 0);
  if (alive.length <= 1) {
    state.loser = alive.length === 1 ? alive[0].i : null;
    state.phase = 'gameover';
    return true;
  }
  return false;
}

function applyPlay(state, playerIdx, cardIdx) {
  if (state.phase !== 'playing')        return { ok: false, reason: 'Игра не идёт' };
  if (state.currentPlayer !== playerIdx) return { ok: false, reason: 'Не ваш ход' };
  const hand = state.hands[playerIdx];
  if (!hand || cardIdx < 0 || cardIdx >= hand.length) return { ok: false, reason: 'Нет такой карты' };

  const card    = hand[cardIdx];
  const tableTop = state.table.length > 0 ? state.table[state.table.length - 1] : null;

  // Проверка: можно ли бросить карту
  if (tableTop && !canCover(tableTop, card)) return { ok: false, reason: 'Нельзя покрыть этой картой' };

  // Бросаем карту
  hand.splice(cardIdx, 1);
  state.table.push(card);

  const eff = cardEffect(card);
  const event = { type: 'play', playerIdx, card, tableTopWas: tableTop, effect: eff };

  if (eff.beatAll) {
    // Д+: все карты на столе (включая только что брошенную) в биту
    state.pile += state.table.length;
    state.table = [];
    state.direction *= -1;
    state.currentPlayer = playerIdx;  // право хода тому кто бросил
    event.flushed = true;
  } else if (eff.flip) {
    // 6 или 8: переворот
    const flushed = tryFlush(state);
    event.flushed = flushed;
    state.direction *= -1;
    if (eff.right === 'thrower') {
      state.currentPlayer = playerIdx;  // 8: право хода бросившему
    } else {
      // 6: ход к следующему в НОВОМ направлении (уже после переворота)
      state.currentPlayer = nextIdx(state.n, playerIdx, state.direction);
    }
  } else {
    const flushed = tryFlush(state);
    event.flushed = flushed;
    state.currentPlayer = nextIdx(state.n, playerIdx, state.direction);
  }

  if (checkEnd(state)) event.gameover = true;
  return { ok: true, event };
}

function applyPickup(state, playerIdx) {
  if (state.phase !== 'playing')        return { ok: false, reason: 'Игра не идёт' };
  if (state.currentPlayer !== playerIdx) return { ok: false, reason: 'Не ваш ход' };
  if (state.table.length === 0)          return { ok: false, reason: 'Стол пуст' };

  state.hands[playerIdx].push(...state.table);
  state.table = [];
  state.currentPlayer = nextIdx(state.n, playerIdx, state.direction);

  const event = { type: 'pickup', playerIdx };
  if (checkEnd(state)) event.gameover = true;
  return { ok: true, event };
}

// ─── РАССЫЛКА ────────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room) {
  const info = room.players.map(p => ({ name: p.name, ready: p.ready, connected: p.ws.readyState === WebSocket.OPEN }));
  room.players.forEach((p, i) => {
    send(p.ws, { type: 'room_update', roomId: room.id, players: info, yourIndex: i });
  });
}

function sendGameState(room) {
  const st = room.state;
  room.players.forEach((p, i) => {
    // Каждый видит только свои карты, чужие — null (рубашка)
    const handsView = st.hands.map((h, hi) => hi === i ? h : h.map(() => null));
    send(p.ws, {
      type: 'game_state',
      myIndex: i,
      hands: handsView,
      table: st.table,
      pile: st.pile,
      currentPlayer: st.currentPlayer,
      direction: st.direction,
      phase: st.phase,
      revealCard: st.revealCard,
      firstPlayer: st.firstPlayer,
      loser: st.loser,
      players: room.players.map(pl => ({ name: pl.name })),
    });
  });
}

function broadcastEvent(room, event) {
  room.players.forEach((p, i) => {
    send(p.ws, { type: 'game_event', myIndex: i, event });
  });
}

// ─── КОМНАТЫ ─────────────────────────────────────────────────────────────────
function findOrCreateRoom() {
  for (const [, room] of rooms) {
    if (room.phase === 'waiting' && room.players.length < 4) return room;
  }
  let id = mkRoomId();
  while (rooms.has(id)) id = mkRoomId();
  const room = { id, players: [], state: null, phase: 'waiting' };
  rooms.set(id, room);
  return room;
}

function removePlayer(ws) {
  const info = wsInfo.get(ws);
  if (!info) return;
  wsInfo.delete(ws);
  const { room } = info;
  const idx = room.players.findIndex(p => p.ws === ws);
  if (idx === -1) return;
  room.players.splice(idx, 1);
  if (room.players.length === 0) {
    rooms.delete(room.id);
  } else {
    if (room.phase === 'playing') {
      broadcastEvent(room, { type: 'player_left' });
    }
    broadcastRoom(room);
  }
}

// ─── WS HANDLER ──────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const info = wsInfo.get(ws);

    // JOIN — найти/создать комнату
    if (msg.type === 'join') {
      if (info) return; // уже в комнате
      const room = findOrCreateRoom();
      const playerIdx = room.players.length;
      room.players.push({ ws, name: msg.name || `Игрок ${playerIdx + 1}`, ready: false });
      wsInfo.set(ws, { room, playerIdx });
      send(ws, { type: 'joined', roomId: room.id, yourIndex: playerIdx });
      broadcastRoom(room);
      return;
    }

    if (!info) return; // не в комнате — игнорируем
    const { room, playerIdx } = info;

    // READY
    if (msg.type === 'ready') {
      room.players[playerIdx].ready = !!msg.isReady;
      broadcastRoom(room);
      // Запуск: минимум 2 игрока, все нажали «Готов»
      if (room.players.length >= 2 && room.players.every(p => p.ready)) {
        room.phase = 'playing';
        room.state = initGame(room.players.length);
        sendGameState(room);
      }
      return;
    }

    // REVEAL_DONE — все подтверждают экран
    if (msg.type === 'reveal_done') {
      if (!room.state || room.state.phase !== 'reveal') return;
      room.state.revealConfirmed = (room.state.revealConfirmed || 0) + 1;
      if (room.state.revealConfirmed >= room.players.length) {
        room.state.phase = 'playing';
        sendGameState(room);
      }
      return;
    }

    // PLAY
    if (msg.type === 'play') {
      if (!room.state) return;
      const res = applyPlay(room.state, playerIdx, msg.cardIndex);
      if (!res.ok) { send(ws, { type: 'error', reason: res.reason }); return; }
      broadcastEvent(room, res.event);
      sendGameState(room);
      return;
    }

    // PICKUP
    if (msg.type === 'pickup') {
      if (!room.state) return;
      const res = applyPickup(room.state, playerIdx);
      if (!res.ok) { send(ws, { type: 'error', reason: res.reason }); return; }
      broadcastEvent(room, res.event);
      sendGameState(room);
      return;
    }
  });

  ws.on('close', () => removePlayer(ws));
  ws.on('error', () => removePlayer(ws));
});

server.listen(PORT, () => console.log(`67 server on :${PORT}`));
