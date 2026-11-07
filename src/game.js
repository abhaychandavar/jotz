'use strict';

// ---------- dino game ----------
// A Chrome-dino style runner. The screen is not stored in S.view, so the app always reopens on the notes list;
// only the high score (S.dinoBest) is persisted.
let inGame = false;
let stopGame = null;

function openGame() {
  if (inGame) return;
  inGame = true;
  if (document.activeElement) document.activeElement.blur();
  pendingAnim = 'fwd';
  setBar('Dino run', true, [iconBtn('full', 'Toggle full screen', () => window.api.toggleFullscreen())]);
  const { s: screen } = prepScreen();
  const wrap = el('div', 'game');
  const cv = el('canvas');
  wrap.append(cv, el('div', 'game-hint', 'Space or ↑ to jump · ↓ to duck · Esc to leave'));
  screen.append(wrap);
  stopGame = runDino(cv);
}

function exitGame() {
  if (!inGame) return;
  stopGame();
  stopGame = null;
  inGame = false;
  pendingAnim = 'back';
  render(); // return to whichever screen (list or note) the game was opened from
}

function runDino(cv) {
  const W = 600, H = 170, GY = 140; // canvas size and ground line (y of the ground)
  const GRAVITY = 2300, JUMP = 650, DINO_X = 40;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  let ink, faint, bg;
  const readColors = () => {
    const cs = getComputedStyle(document.body);
    ink = cs.getPropertyValue('--ink').trim();
    faint = cs.getPropertyValue('--ink-faint').trim();
    bg = cs.getPropertyValue('--card').trim();
  };
  readColors();

  let best = S.dinoBest || 0;
  let state = 'ready'; // ready | run | over
  let paused = false;
  let dino, obs, clouds, speed, score, wait, nextGap, gx, t, overAt, flashUntil, lastHundred;

  const reset = () => {
    dino = { y: 0, vy: 0, duck: dino ? dino.duck : false }; // y is the height above the ground
    obs = [];
    clouds = [{ x: 140, y: 28 }, { x: 400, y: 52 }];
    speed = 280; score = 0; wait = 0.9; nextGap = 0; gx = 0; t = 0; flashUntil = 0; lastHundred = 0;
  };
  reset();

  const rnd = (a, b) => a + Math.random() * (b - a);
  const spawn = () => {
    if (score > 250 && Math.random() < 0.28) {
      obs.push({ type: 'bird', x: W + 10, w: 42, h: 30, y: [0, 40, 75][Math.floor(Math.random() * 3)] });
    } else {
      const large = Math.random() < 0.5;
      const n = score > 100 ? 1 + Math.floor(Math.random() * 3) : 1;
      const uw = large ? 26 : 18;
      obs.push({ type: 'cactus', x: W + 10, w: n * uw + (n - 1) * 3, h: large ? 52 : 36, y: 0, n, uw });
    }
    nextGap = speed * rnd(0.8, 1.6);
  };

  const jump = () => { if (dino.y === 0) dino.vy = JUMP; };
  const finish = () => {
    state = 'over';
    overAt = performance.now();
    if (Math.floor(score) > best) {
      best = Math.floor(score);
      S.dinoBest = best;
      flush();
    }
  };
  const action = () => {
    if (paused) { paused = false; last = performance.now(); return; }
    if (state === 'ready') { state = 'run'; jump(); }
    else if (state === 'run') jump();
    else if (performance.now() - overAt > 300) { reset(); state = 'run'; }
  };

  const hitbox = () => (dino.duck && dino.y === 0
    ? { x: DINO_X, w: 54, y: dino.y, h: 24 }
    : { x: DINO_X + 6, w: 34, y: dino.y, h: 44 });

  const update = (dt) => {
    t += dt;
    speed = Math.min(720, speed + 8 * dt);
    score += speed * dt * 0.035;
    gx += speed * dt;
    const hundred = Math.floor(score / 100);
    if (hundred > lastHundred) { lastHundred = hundred; flashUntil = t + 0.6; }

    if (dino.y > 0 || dino.vy > 0) {
      dino.vy -= GRAVITY * (dino.duck ? 3 : 1) * dt;
      dino.y += dino.vy * dt;
      if (dino.y <= 0) { dino.y = 0; dino.vy = 0; }
    }
    clouds.forEach(c => { c.x -= speed * 0.15 * dt; if (c.x < -50) { c.x = W + rnd(0, 120); c.y = rnd(20, 70); } });

    obs.forEach(o => { o.x -= speed * dt; });
    obs = obs.filter(o => o.x + o.w > -10);
    const lastOb = obs[obs.length - 1];
    if (!lastOb) { wait -= dt; if (wait <= 0) spawn(); }
    else if (W - (lastOb.x + lastOb.w) >= nextGap) spawn();

    const d = hitbox();
    for (const o of obs) {
      const ox = o.x + 3, ow = o.w - 6, oy = o.y, oh = o.h - 3;
      if (d.x < ox + ow && d.x + d.w > ox && d.y < oy + oh && d.y + d.h > oy) { finish(); break; }
    }
  };

  // ----- drawing -----
  const rect = (x, y, w, h) => ctx.fillRect(Math.round(x), Math.round(y), w, h);
  const drawDino = () => {
    const base = GY - dino.y, x = DINO_X;
    const stride = state === 'run' && dino.y === 0 ? Math.floor(t * 10) % 2 : 0;
    ctx.fillStyle = ink;
    if (dino.duck && dino.y === 0) {
      rect(x - 6, base - 22, 10, 6);
      rect(x, base - 24, 44, 18);
      rect(x + 36, base - 28, 22, 14);
      rect(x + 10, base - 6, 6, stride ? 6 : 3);
      rect(x + 26, base - 6, 6, stride ? 3 : 6);
      ctx.fillStyle = bg;
      rect(x + 48, base - 25, 4, 4);
    } else {
      rect(x - 2, base - 34, 10, 8);
      rect(x + 6, base - 36, 26, 24);
      rect(x + 24, base - 46, 20, 18);
      rect(x + 30, base - 22, 8, 4);
      rect(x + 10, base - 12, 6, dino.y > 0 ? 12 : stride ? 12 : 6);
      rect(x + 22, base - 12, 6, dino.y > 0 ? 12 : stride ? 6 : 12);
      ctx.fillStyle = bg;
      if (state === 'over') { rect(x + 35, base - 43, 6, 6); ctx.fillStyle = ink; rect(x + 37, base - 41, 2, 2); ctx.fillStyle = bg; }
      else rect(x + 36, base - 42, 4, 4);
      rect(x + 34, base - 33, 10, 2);
    }
  };
  const drawObstacle = (o) => {
    ctx.fillStyle = ink;
    if (o.type === 'bird') {
      const yb = GY - o.y, up = Math.floor(t * 8) % 2;
      rect(o.x, yb - 20, 10, 6);
      rect(o.x + 8, yb - 20, 26, 8);
      rect(o.x + 32, yb - 18, 8, 4);
      if (up) rect(o.x + 14, yb - 30, 10, 10); else rect(o.x + 14, yb - 12, 10, 10);
      return;
    }
    for (let i = 0; i < o.n; i++) {
      const ux = o.x + i * (o.uw + 3), w = o.uw, h = o.h;
      rect(ux + w * 0.36, GY - h, w * 0.28, h);
      rect(ux, GY - h * 0.45, w * 0.4, 4);
      rect(ux, GY - h * 0.45 - 12, 4, 16);
      rect(ux + w * 0.6, GY - h * 0.6, w * 0.4, 4);
      rect(ux + w - 4, GY - h * 0.6 - 10, 4, 14);
    }
  };
  const pad = (n) => String(Math.floor(n)).padStart(5, '0');
  const center = (text, y, size, color) => {
    ctx.font = `600 ${size}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, W / 2, y);
  };
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = faint;
    ctx.globalAlpha = 0.35;
    clouds.forEach(c => { rect(c.x, c.y, 40, 8); rect(c.x + 8, c.y - 6, 24, 6); });
    ctx.globalAlpha = 1;
    ctx.fillRect(0, GY, W, 1.5);
    for (let i = 0; i < 14; i++) {
      const px = (((i * 53 - gx) % (W + 50)) + (W + 50)) % (W + 50) - 25;
      rect(px, GY + 7 + (i % 3) * 5, 2 + (i % 4) * 2, 2);
    }
    obs.forEach(drawObstacle);
    drawDino();

    ctx.font = '600 13px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    const blink = t < flashUntil && Math.floor(t * 10) % 2 === 0;
    ctx.fillStyle = faint;
    ctx.fillText(`HI ${pad(best)}`, W - 90, 22);
    ctx.fillStyle = ink;
    if (!blink) ctx.fillText(pad(score), W - 14, 22);

    if (paused) center('Paused · press Space', 80, 15, ink);
    else if (state === 'ready') center('Press Space to start', 80, 15, ink);
    else if (state === 'over') {
      center('G A M E   O V E R', 70, 18, ink);
      center(Math.floor(score) >= best && best > 0 ? 'New high score!  Space to restart' : 'Space to restart', 94, 12, faint);
    }
  };

  // ----- input & loop -----
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); exitGame(); return; }
    if (e.code === 'Space' || e.key === 'ArrowUp') { e.preventDefault(); if (!e.repeat) action(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); dino.duck = true; }
  };
  const onKeyUp = (e) => {
    if (e.code === 'Space') e.preventDefault();
    if (e.key === 'ArrowDown') dino.duck = false;
  };
  const onBlur = () => { if (state === 'run') paused = true; };
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  cv.addEventListener('pointerdown', action);

  let last = performance.now(), raf = 0, frames = 0;
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (++frames % 30 === 0) readColors();
    if (state === 'run' && !paused) update(dt);
    draw();
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}
