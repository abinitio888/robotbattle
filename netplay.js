// Vänmatcher: en WebSocket-anslutning till servern plus lockstep-synkning av indata.
//
// Idén: båda spelarna kör exakt samma simulering lokalt. Ingen skickar sin position,
// bara vilka knappar som var nedtryckta för en viss "tick" (ett fast simuleringssteg).
// Varje sida väntar tills den har BÅDA spelarnas indata för en tick innan den
// simulerar den tickens steg, så de två sidorna hamnar alltid i exakt samma tillstånd.
// Insatsen läggs INPUT_DELAY tickar (skickad från servern) i förväg för att hinna fram
// innan den behövs, annars stannar simuleringen upp och väntar.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NetPlay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function encodeInput(input) {
    return (input.dir < 0 ? 1 : 0) | (input.dir > 0 ? 2 : 0) | (input.jump ? 4 : 0) | (input.attack ? 8 : 0) | (input.special ? 16 : 0);
  }

  function decodeInput(bits) {
    return {
      dir: (bits & 2 ? 1 : 0) - (bits & 1 ? 1 : 0),
      jump: !!(bits & 4),
      attack: !!(bits & 8),
      special: !!(bits & 16),
    };
  }

  // 32-bitars FNV-liknande hash, bara för att upptäcka om något gått isär mellan klienterna.
  function hashState(nums) {
    let h = 0x811c9dc5;
    for (const n of nums) {
      h ^= n | 0;
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  class Room {
    constructor(ws) {
      this.ws = ws;
      this.handlers = {};
      this.slot = null;
      this.delay = 6;
      this.opponentName = '';
      this.tick = 0;          // nästa tick som väntar på att simuleras
      this.sentUpTo = -1;     // sista tick vi skickat indata för
      this.local = {};        // tick -> bits, vårt eget
      this.remote = {};       // tick -> bits, motståndarens
      this.remoteHash = {};   // tick -> hash från motståndaren
      this.localHash = {};    // tick -> vår egen hash, sparad för att kunna jämföra när motståndarens dyker upp
      this.stalled = false;
      this.stallSince = 0;
      ws.addEventListener('message', (ev) => this.onMessage(JSON.parse(ev.data)));
      ws.addEventListener('close', () => this.emit('left', { reason: 'Anslutningen bröts.' }));
    }

    on(name, fn) { this.handlers[name] = fn; }
    emit(name, data) { if (this.handlers[name]) this.handlers[name](data); }

    send(msg) { if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg)); }

    onMessage(msg) {
      if (msg.t === 'created') return this.emit('created', msg);
      if (msg.t === 'error') return this.emit('error', msg);
      if (msg.t === 'left') return this.emit('left', msg);
      if (msg.t === 'rematch') return this.emit('rematch', msg);
      if (msg.t === 'start') {
        this.slot = msg.slot;
        this.delay = msg.delay;
        this.opponentName = msg.players[1 - msg.slot].name;
        this.tick = 0;
        this.sentUpTo = -1;
        this.local = {};
        this.remote = {};
        this.remoteHash = {};
        this.localHash = {};
        this.stalled = false;
        // Utan det här skulle ingen sida någonsin fylla i tickarna 0..delay-1: den första
        // riktiga insatsen skickas alltid för tick "nu + delay", så de tidigaste tickarna
        // måste fyllas i direkt med en neutral knapptryckning, annars väntar simuleringen
        // för evigt på indata som aldrig kommer.
        for (let t = 0; t < this.delay; t++) {
          this.local[t] = 0;
          this.send({ t: 'in', tick: t, bits: 0 });
        }
        this.sentUpTo = this.delay - 1;
        return this.emit('start', msg);
      }
      if (msg.t === 'in') { this.remote[msg.tick] = msg.bits; return null; }
      if (msg.t === 'h') {
        this.remoteHash[msg.tick] = msg.h;
        // Om vår egen hash för den här tickern redan är beräknad (motståndarens meddelande kom
        // sent, efter att vi själva redan simulerat förbi den) jämför vi här i stället — annars
        // skulle jämförelsen missas helt eftersom den i advance() bara körs i farten.
        const mine = this.localHash[msg.tick];
        if (mine !== undefined && mine !== msg.h) this.emit('desync', { tick: msg.tick });
        return null;
      }
      return null;
    }

    create(robot) { this.send({ t: 'create', robot }); }
    join(code, robot) { this.send({ t: 'join', code, robot }); }
    rematch() { this.send({ t: 'rematch' }); }
    leave() { this.send({ t: 'leave' }); this.ws.close(); }

    // sample() ger vår lokala spelares knapptillstånd just nu, som {dir, jump, attack, special}.
    // step(dt, inputA, inputB) kör ett simuleringssteg. inputA/inputB är i slot-ordning (0, 1),
    // inte "jag/motståndare" — så båda sidor kör identiska anrop.
    // Returnerar hur många tickar som faktiskt simulerades (0 om vi väntar på nätverket).
    advance(sample, step, hashOf) {
      const myTick = this.tick + this.delay;
      // this.tick kan hoppa framåt mer än ett steg mellan två anrop (till exempel precis efter
      // uppvärmningstickarna, eller om renderingen har hackat till). Då måste VARJE tick mellan
      // sentUpTo och myTick få sin egen indata skickad, annars uppstår ett hål som aldrig fylls
      // i och simuleringen fastnar för alltid.
      while (this.sentUpTo < myTick) {
        this.sentUpTo += 1;
        const bits = encodeInput(sample());
        this.local[this.sentUpTo] = bits;
        this.send({ t: 'in', tick: this.sentUpTo, bits });
      }
      let advanced = 0;
      while (this.local[this.tick] !== undefined && this.remote[this.tick] !== undefined) {
        const a = this.slot === 0 ? this.local[this.tick] : this.remote[this.tick];
        const b = this.slot === 0 ? this.remote[this.tick] : this.local[this.tick];
        // step() kan returnera false för att säga "sluta här" (till exempel: matchen tog just
        // slut). Annars skulle en sida, bara för att den råkat ha fler tickar redan buffrade,
        // kunna hinna simulera några extra tickar efter matchslut som den andra sidan aldrig
        // simulerar — ofarligt för utfallet, men gör att räknarna inte längre stämmer överens.
        const cont = step(decodeInput(a), decodeInput(b));
        if (hashOf && this.tick % 30 === 0) {
          const h = hashState(hashOf());
          this.localHash[this.tick] = h;
          this.send({ t: 'h', tick: this.tick, h });
          const got = this.remoteHash[this.tick];
          if (got !== undefined && got !== h) this.emit('desync', { tick: this.tick });
        }
        delete this.local[this.tick];
        delete this.remote[this.tick];
        this.tick += 1;
        advanced += 1;
        if (cont === false) break;
      }
      this.stalled = advanced === 0;
      return advanced;
    }
  }

  function connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const onOpen = () => { cleanup(); resolve(new Room(ws)); };
      const onFail = () => { cleanup(); reject(new Error('Kunde inte ansluta till servern.')); };
      function cleanup() {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onFail);
        ws.removeEventListener('close', onFail);
      }
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onFail);
      ws.addEventListener('close', onFail);
    });
  }

  return { connect, encodeInput, decodeInput, hashState, Room };
});
