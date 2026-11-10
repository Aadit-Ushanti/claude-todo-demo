import { BIKE_INFO } from '../game/Roster.js';

/**
 * Race HUD: speed, place, timer, health, weapon chips, progress bar with rider dots, hints, countdown, toasts,
 * pause and results overlays. update() writes to the DOM only when a value changed.
 * @param {HTMLElement} root
 * @param {{onResume?:()=>void, onMenu?:()=>void, onAgain?:()=>void, onPause?:()=>void, onNext?:()=>void, onContinue?:()=>void}} [handlers]
 * @returns {object} HUD controller
 */
export function createHud(root, handlers = {}) {
  const dots = Array.from({ length: 15 }, () => '<i class="hud-dot"></i>').join('');
  root.innerHTML = `
    <div class="hud-race" hidden>
      <div class="hud-left">
        <div class="hud-speed"><span data-k="speed">0</span><small>km/h</small></div>
        <div class="hud-health"><div class="hud-health-bar" data-k="health"></div></div>
        <div class="hud-weapons">
          <span data-w="punch">PUNCH</span><span data-w="baton">BATON</span><span data-w="chain">CHAIN</span>
          <em data-k="side">AUTO</em>
        </div>
      </div>
      <div class="hud-top">
        <div class="hud-place"><span data-k="place">1</span><small>/ <span data-k="total">15</span></small></div>
        <div class="hud-time" data-k="time">0:00.0</div>
      </div>
      <div class="hud-right">
        <div class="hud-meta" data-k="meta"></div>
        <div class="hud-riders" data-k="riders">1 rider + 14 AI</div>
        <div class="hud-net" data-k="net">solo</div>
        <button class="hud-pausebtn" data-k="pausebtn" hidden aria-label="Pause">II</button>
      </div>
      <div class="hud-hint" data-k="hint"></div>
      <div class="hud-count" data-k="count"></div>
      <div class="hud-toast" data-k="toast"></div>
      <div class="hud-progress"><b></b>${dots}</div>
    </div>
    <div class="hud-modal" data-k="pause" hidden>
      <div class="hud-card"><h2>Paused</h2>
        <button class="primary" data-act="resume">Resume</button>
        <button data-act="again">Restart race</button>
        <button data-act="menu">Quit to menu</button></div>
    </div>
    <div class="hud-modal" data-k="results" hidden>
      <div class="hud-card hud-results" data-k="resultscard"><h2 data-k="resulttitle">Results</h2>
        <div class="hud-yourplace" data-k="yourplace"></div>
        <div class="hud-cols">
          <section><h3 data-k="racehead">Race</h3><ol data-k="rows" class="hud-racerows"></ol></section>
          <section data-k="champsec" hidden><h3 data-k="champhead">Championship</h3><ol data-k="table" class="hud-table"></ol></section>
        </div>
        <div class="hud-breaknote" data-k="breaknote" hidden></div>
        <div class="hud-actions"><button class="primary" data-act="again">Race again</button><button class="primary" data-act="next" hidden>Next race</button><button data-act="pausebreak" hidden>Pause</button><button data-act="menu">Menu</button></div>
      </div>
    </div>
    <div class="hud-modal" data-k="final" hidden>
      <div class="hud-card hud-final"><h2>Championship final</h2>
        <div class="hud-champion" data-k="champion"></div>
        <div class="hud-podium" data-k="podium"></div>
        <div class="hud-yourplace" data-k="finalmine"></div>
        <ol data-k="finaltable" class="hud-table"></ol>
        <div class="hud-actions"><button class="primary" data-act="continue" data-k="continuebtn">Continue</button></div>
      </div>
    </div>`;

  const el = {};
  root.querySelectorAll('[data-k]').forEach((n) => { el[n.dataset.k] = n; });
  const race = root.querySelector('.hud-race');
  const dotEls = Array.from(root.querySelectorAll('.hud-dot'));
  const chips = {};
  root.querySelectorAll('[data-w]').forEach((n) => { chips[n.dataset.w] = n; });
  const last = {};
  let toastTimer = 0;

  const setText = (k, v) => { if (last[k] !== v) { last[k] = v; el[k].textContent = v; } };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'resume' && handlers.onResume) handlers.onResume();
    else if (a === 'menu' && handlers.onMenu) handlers.onMenu();
    else if (a === 'again' && handlers.onAgain) handlers.onAgain();
    else if (a === 'next' && handlers.onNext) handlers.onNext();
    else if (a === 'continue' && handlers.onContinue) handlers.onContinue();
    else if (a === 'pausebreak' && handlers.onPause) handlers.onPause();
  });
  el.pausebtn.addEventListener('click', () => { if (handlers.onPause) handlers.onPause(); });

  /** m:ss.t */
  const fmt = (t) => {
    if (!(t >= 0)) t = 0;
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
  };

  let animTimer = 0, animRaf = 0;
  function stopAnim() { clearTimeout(animTimer); cancelAnimationFrame(animRaf); animTimer = 0; animRaf = 0; }
  const reduced = () => { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; } };
  const TROPHY_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 6h20v10a10 10 0 0 1-20 0V6z" fill="currentColor"/><path d="M14 9H6c0 8 3 12 8 13M34 9h8c0 8-3 12-8 13" fill="none" stroke="currentColor" stroke-width="3"/><rect x="21" y="26" width="6" height="8" fill="currentColor"/><rect x="14" y="36" width="20" height="6" rx="2" fill="currentColor"/></svg>';

  /** Short coloured tag of a bike type (SP / ST / CR) next to a rider's name. */
  const bikeTag = (id) => {
    const t = document.createElement('i');
    t.className = `bk bk-${id}`;
    t.textContent = BIKE_INFO[id] ? BIKE_INFO[id].tag : '';
    t.title = BIKE_INFO[id] ? BIKE_INFO[id].name : id;
    return t;
  };

  /** Fill an <ol class="hud-table">. animate: show previous order/totals first, then count up and re-sort (FLIP). */
  function renderTable(ol, table, animate) {
    const anim = animate && !reduced() && table.some((x) => x.prevRank != null && x.prevTotal !== x.total);
    const nodes = new Map();
    const mk = (x) => {
      const li = document.createElement('li');
      li.className = (x.me ? 'me ' : '') + (x.human ? 'human' : 'ai');
      li.innerHTML = '<span class="rk"></span><span class="nm"></span><span class="gn"></span><span class="tt"></span>';
      li.children[1].textContent = x.name;
      if (x.bike) li.children[1].appendChild(bikeTag(x.bike));
      li.children[2].textContent = x.gained > 0 ? `+${x.gained}` : '';
      li.dataset.total = String(x.total);
      if (x.bike) li.dataset.bike = x.bike;
      li.dataset.name = x.name;
      nodes.set(x, li);
      return li;
    };
    const setRank = (list) => list.forEach((x, i) => { nodes.get(x).children[0].textContent = String(i + 1); nodes.get(x).dataset.rank = String(i + 1); });
    const lis = table.map(mk);
    void lis;
    if (!anim) {
      table.forEach((x) => { nodes.get(x).children[3].textContent = String(x.total); });
      setRank(table);
      ol.replaceChildren(...table.map((x) => nodes.get(x)));
      return;
    }
    const before = table.slice().sort((a, b) => a.prevRank - b.prevRank);
    table.forEach((x) => { nodes.get(x).children[3].textContent = String(x.prevTotal); nodes.get(x).children[2].textContent = ''; });
    setRank(before);
    ol.replaceChildren(...before.map((x) => nodes.get(x)));
    animTimer = setTimeout(() => {
      const tops = new Map(table.map((x) => [x, nodes.get(x).getBoundingClientRect().top]));
      table.forEach((x) => { nodes.get(x).children[2].textContent = x.gained > 0 ? `+${x.gained}` : ''; });
      ol.replaceChildren(...table.map((x) => nodes.get(x)));
      setRank(table);
      for (const x of table) {
        const n = nodes.get(x);
        const dy = tops.get(x) - n.getBoundingClientRect().top;
        n.style.transition = 'none'; n.style.transform = `translateY(${dy}px)`;
      }
      void ol.offsetWidth;
      const T = 800, t0 = performance.now();
      for (const x of table) { const n = nodes.get(x); n.style.transition = `transform ${T}ms ease`; n.style.transform = ''; }
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / T);
        for (const x of table) nodes.get(x).children[3].textContent = String(Math.round(x.prevTotal + (x.total - x.prevTotal) * k));
        if (k < 1) animRaf = requestAnimationFrame(tick);
      };
      animRaf = requestAnimationFrame(tick);
    }, 1000);
  }

  return {
    fmt,
    /** @param {boolean} v show the in-race HUD */
    setVisible(v) { race.hidden = !v; },
    /** @param {boolean} v show the on-screen pause button */
    setPauseButton(v) { el.pausebtn.hidden = !v; },
    /**
     * @param {{speedKmh:number, health:number, place:number, total:number, timeS:number, riders:string, net:string,
     *   weapon:(string|null), attacking:boolean, side:string, hint:string, count:string, dots:{p:number, kind:string}[], meta?:string}} s
     */
    update(s) {
      setText('speed', String(Math.round(s.speedKmh)));
      const h = Math.max(0, Math.min(100, Math.round(s.health)));
      if (last.health !== h) { last.health = h; el.health.style.width = `${h}%`; el.health.classList.toggle('low', h < 30); }
      setText('place', String(s.place));
      setText('total', String(s.total));
      setText('time', fmt(s.timeS));
      setText('meta', s.meta || '');
      setText('riders', s.riders);
      setText('net', s.net);
      setText('side', s.side);
      setText('hint', s.hint || '');
      if (last.hintOn !== !!s.hint) { last.hintOn = !!s.hint; el.hint.classList.toggle('on', !!s.hint); }
      if (last.count !== s.count) {
        last.count = s.count; el.count.textContent = s.count; el.count.classList.toggle('on', !!s.count);
        el.count.classList.remove('pop'); void el.count.offsetWidth; el.count.classList.add('pop');
      }
      const wk = s.weapon || '';
      if (last.wk !== wk + (s.attacking ? '!' : '')) {
        last.wk = wk + (s.attacking ? '!' : '');
        for (const k in chips) { chips[k].classList.toggle('sel', k === wk); chips[k].classList.toggle('swing', k === wk && s.attacking); }
      }
      for (let i = 0; i < dotEls.length; i++) {
        const d = s.dots[i], n = dotEls[i];
        if (!d) { if (!n.hidden) n.hidden = true; continue; }
        n.hidden = false;
        n.style.left = `${(d.p * 100).toFixed(1)}%`;
        if (n.dataset.kind !== d.kind) { n.dataset.kind = d.kind; n.className = `hud-dot ${d.kind}`; }
      }
    },
    /** Short notice, e.g. "Rider 3 disconnected: AI took over". */
    toast(text, ms = 3000) {
      el.toast.textContent = text;
      el.toast.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.toast.classList.remove('on'), ms);
    },
    /** @param {boolean} v */
    showPause(v, again = true) { el.pause.hidden = !v; el.pause.querySelector('[data-act=again]').hidden = !again; },
    /** @param {string} text line under the standings during the championship break ('' hides it) */
    setBreakNote(text) {
      if (last.bn === text) return;
      last.bn = text; el.breaknote.textContent = text; el.breaknote.hidden = !text;
      el.results.querySelector('[data-act=pausebreak]').hidden = !text;
    },
    /**
     * @param {{rows:{place:number, name:string, time:string, me:boolean, kind:string, pts?:string}[], title:string, again:boolean,
     *   champ?:{heading:string, tableHeading:string, table:ChampRow[], next:{text:string, hidden?:boolean, disabled?:boolean}|null, animate?:boolean}}} r
     *   ChampRow = {name, total, prevTotal, prevRank, gained, delta, me, human}; `table` is in the NEW order. With `champ`,
     *   the standings first show the previous order and totals, then count up and re-sort (instantly with prefers-reduced-motion).
     */
    showResults(r) {
      stopAnim();
      el.final.hidden = true;
      el.results.hidden = false;
      el.resultscard.classList.toggle('wide', !!r.champ);
      el.resulttitle.textContent = r.champ ? r.champ.heading : 'Results';
      el.racehead.textContent = r.champ ? 'Finishing order' : '';
      el.racehead.hidden = !r.champ;
      el.yourplace.textContent = r.title;
      el.rows.replaceChildren(...r.rows.map((x) => {
        const li = document.createElement('li');
        li.className = (x.me ? 'me ' : '') + x.kind + (x.pts != null ? ' pts' : '');
        li.innerHTML = '<span class="pl"></span><span class="nm"></span><span class="tm"></span>' + (x.pts != null ? '<span class="pt"></span>' : '');
        li.children[0].textContent = String(x.place);
        li.children[1].textContent = x.name;
        if (x.bike) { li.children[1].appendChild(bikeTag(x.bike)); li.dataset.bike = x.bike; }
        li.children[2].textContent = x.time;
        if (x.pts != null) li.children[3].textContent = x.pts;
        return li;
      }));
      const again = el.results.querySelector('[data-act="again"]');
      const next = el.results.querySelector('[data-act="next"]');
      again.hidden = !r.again || !!r.champ;
      if (r.again) { again.textContent = r.againText || 'Race again'; again.disabled = !!r.againDisabled; }
      el.breaknote.hidden = !r.champ; last.bn = null;
      el.results.querySelector('[data-act=pausebreak]').hidden = !r.champ;
      el.champsec.hidden = !r.champ;
      next.hidden = !(r.champ && r.champ.next);
      if (r.champ) {
        el.champhead.textContent = r.champ.tableHeading;
        if (r.champ.next) { next.textContent = r.champ.next.text; next.disabled = !!r.champ.next.disabled; }
        renderTable(el.table, r.champ.table, r.champ.animate !== false);
      }
    },
    /**
     * Final championship screen: champion, gold/silver/bronze podium, the player(s) rank, the full table.
     * @param {{champion:string, podium:{rank:number,name:string,points:number,me:boolean,human:boolean}[], mine:string, table:ChampRow[]}} f
     */
    showFinal(f) {
      stopAnim();
      el.results.hidden = true;
      el.final.hidden = false;
      el.champion.textContent = f.champion;
      el.podium.replaceChildren(...f.podium.map((x) => {
        const d = document.createElement('div');
        d.className = `hud-trophy t${x.rank}` + (x.rank === 1 ? ' champ' : '') + (x.me ? ' me' : '') + (x.human ? ' human' : '');
        d.innerHTML = TROPHY_SVG + '<b class="tn"></b><span class="tp"></span><small class="tm"></small>';
        d.querySelector('.tn').textContent = x.name;
        d.querySelector('.tp').textContent = `${x.points} pts`;
        d.querySelector('.tm').textContent = ['', 'GOLD', 'SILVER', 'BRONZE'][x.rank];
        return d;
      }));
      el.finalmine.textContent = f.mine + (f.note ? `   (${f.note})` : '');
      el.continuebtn.textContent = f.button || 'Continue';
      renderTable(el.finaltable, f.table, false);
    },
    hideResults() { stopAnim(); el.results.hidden = true; el.final.hidden = true; },
    get resultsOpen() { return !el.results.hidden || !el.final.hidden; },
  };
}
