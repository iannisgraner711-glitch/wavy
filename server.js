const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const SPECTRUMS = [
  ["Cold", "Hot"],
  ["Overrated", "Underrated"],
  ["Terrible Movie", "Masterpiece"],
  ["Useless Superpower", "God-Tier Superpower"],
  ["Guilty Pleasure", "Openly Loved"],
  ["Bad First Date", "Great First Date"],
  ["Smells Terrible", "Smells Amazing"],
  ["Needs Luck", "Needs Skill"],
  ["Snack", "Full Meal"],
  ["Mainstream", "Niche"],
  ["Harmless", "Deadly"],
  ["Ancient", "Futuristic"],
  ["Boring Hobby", "Thrilling Hobby"],
  ["Cheap", "Expensive"],
  ["Villain", "Hero"]
];

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms[code] ? generateRoomCode() : code;
}

function getRandomSpectrum(usedIndices = []) {
  if (usedIndices.length >= SPECTRUMS.length) usedIndices.length = 0;
  let idx;
  do {
    idx = Math.floor(Math.random() * SPECTRUMS.length);
  } while (usedIndices.includes(idx));
  usedIndices.push(idx);
  return SPECTRUMS[idx];
}

function startNewRound(room) {
  room.round += 1;
  // Swap psychic between player 0 and player 1
  room.psychicIndex = room.round % 2 === 1 ? 0 : 1;
  room.target = Math.floor(Math.random() * 81) + 10; // Keep target between 10 and 90
  room.spectrum = getRandomSpectrum(room.usedSpectrums);
  room.clue = '';
  room.guess = 50;
  room.phase = 'CLUE'; // CLUE -> GUESS -> REVEAL
  room.lastPoints = 0;
}

function emitRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.players.forEach((player, index) => {
    const isPsychic = index === room.psychicIndex;
    // Hide the target from the Guesser until the REVEAL phase
    const visibleTarget = (isPsychic || room.phase === 'REVEAL') ? room.target : null;

    io.to(player.id).emit('gameState', {
      roomCode,
      players: room.players.map(p => ({ name: p.name, score: p.score })),
      youIndex: index,
      isPsychic,
      round: room.round,
      phase: room.phase,
      spectrum: room.spectrum,
      target: visibleTarget,
      clue: room.clue,
      guess: room.guess,
      lastPoints: room.lastPoints
    });
  });
}

io.on('connection', (socket) => {
  socket.on('createRoom', (playerName) => {
    const code = generateRoomCode();
    rooms[code] = {
      players: [{ id: socket.id, name: playerName || 'Player 1', score: 0 }],
      round: 0,
      psychicIndex: 0,
      target: 50,
      spectrum: SPECTRUMS[0],
      usedSpectrums: [],
      clue: '',
      guess: 50,
      phase: 'WAITING',
      lastPoints: 0
    };
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomCreated', code);
    emitRoomState(code);
  });

  socket.on('joinRoom', ({ code, playerName }) => {
    const roomCode = (code || '').toUpperCase().trim();
    const room = rooms[roomCode];

    if (!room) {
      return socket.emit('errorMsg', 'Room not found.');
    }
    if (room.players.length >= 2) {
      return socket.emit('errorMsg', 'Room is already full (2 players max).');
    }

    room.players.push({ id: socket.id, name: playerName || 'Player 2', score: 0 });
    socket.join(roomCode);
    socket.roomCode = roomCode;

    startNewRound(room);
    emitRoomState(roomCode);
  });

  socket.on('submitClue', (clue) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'CLUE') return;
    if (room.players[room.psychicIndex]?.id !== socket.id) return;

    room.clue = clue.trim();
    room.phase = 'GUESS';
    emitRoomState(socket.roomCode);
  });

  socket.on('updateDial', (value) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'GUESS') return;
    // Broadcast live dial movement to the Psychic so they can watch!
    room.guess = Number(value);
    socket.to(socket.roomCode).emit('dialMoved', room.guess);
  });

  socket.on('lockGuess', (finalGuess) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'GUESS') return;
    if (room.players[room.psychicIndex]?.id === socket.id) return;

    room.guess = Number(finalGuess);
    const diff = Math.abs(room.target - room.guess);

    let points = 0;
    if (diff <= 4) points = 4;
    else if (diff <= 10) points = 3;
    else if (diff <= 16) points = 2;

    room.lastPoints = points;
    // Both players share team score or individual score; here we award both for co-op or the guesser for competitive.
    // Let's award points to the team/both or active guesser. Let's make it competitive: Guesser & Psychic both get points, or Guesser gets points!
    const guesserIndex = room.psychicIndex === 0 ? 1 : 0;
    room.players[guesserIndex].score += points;
    if (points === 4) room.players[room.psychicIndex].score += 1; // Bonus point for Psychic on bullseye!

    room.phase = 'REVEAL';
    emitRoomState(socket.roomCode);
  });

  socket.on('nextRound', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'REVEAL') return;
    startNewRound(room);
    emitRoomState(socket.roomCode);
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      io.to(code).emit('errorMsg', 'The other player disconnected. Refresh to start a new game.');
      delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wavy server running on port ${PORT}`);
});