/**
 * 手寫筆記電子化 — Main Script
 */
'use strict';

const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];

/* ── Nav mobile toggle ── */
function initNav() {
  const toggle = $('.nav__toggle');
  const links  = $('.nav__links');
  if (!toggle || !links) return;

  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  });

  links.addEventListener('click', e => {
    if (e.target.tagName === 'A') {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }
  });

  document.addEventListener('click', e => {
    const nav = $('.nav');
    if (!nav) return;
    if (!nav.contains(e.target) && links.classList.contains('open')) {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }
  });
}

/* ── Active nav link via IntersectionObserver ── */
function initActiveNav() {
  const sections = $$('section[id]');
  const anchors  = $$('.nav__links a[href^="#"]');
  if (!sections.length || !anchors.length) return;

  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      anchors.forEach(a => {
        if (a.getAttribute('href') === '#' + e.target.id) {
          a.setAttribute('aria-current', 'page');
        } else {
          a.removeAttribute('aria-current');
        }
      });
    });
  }, { threshold: 0.35 });

  sections.forEach(s => io.observe(s));
}

/* ── Fade-in on scroll (opacity only) ── */
function initReveal() {
  const els = $$('.reveal');
  if (!els.length) return;

  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -20px 0px' });

  els.forEach(el => io.observe(el));
}

/* ── Animated counter ── */
function countUp(el, target, dur = 900) {
  const start = performance.now();
  const tick  = now => {
    const p = Math.min((now - start) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * e);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function initCounters() {
  const els = $$('[data-count]');
  if (!els.length) return;

  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        countUp(e.target, parseInt(e.target.dataset.count, 10));
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.6 });

  els.forEach(el => io.observe(el));
}

/* ── Smooth scroll ── */
function initScroll() {
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const id  = a.getAttribute('href').slice(1);
    const tgt = document.getElementById(id);
    if (!tgt) return;
    e.preventDefault();
    const navH = $('.nav')?.offsetHeight ?? 56;
    window.scrollTo({
      top: tgt.getBoundingClientRect().top + scrollY - navH - 16,
      behavior: 'smooth'
    });
  });
}

/* ── Note cards: full-card click ── */
function initCards() {
  $$('.note-card[data-href]').forEach(card => {
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');

    card.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      window.open(card.dataset.href, '_blank', 'noopener');
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        window.open(card.dataset.href, '_blank', 'noopener');
      }
    });
  });
}

/* ── Back to top ── */
function initBackTop() {
  const btn = document.createElement('button');
  btn.className = 'back-to-top';
  btn.setAttribute('aria-label', '回到頂端');
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2.5"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 19V5M5 12l7-7 7 7"/>
  </svg>`;
  document.body.appendChild(btn);

  window.addEventListener('scroll', () => {
    btn.classList.toggle('vis', window.scrollY > 400);
  }, { passive: true });

  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initActiveNav();
  initReveal();
  initCounters();
  initScroll();
  initCards();
  initBackTop();
});
