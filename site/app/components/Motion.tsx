"use client";

import { useEffect } from "react";
import "./motion.css";

/**
 * Motion wiring, borrowed but hand-built: no animation library rides
 * along. Three grammars, one paper voice . 
 *
 *  - headline wipes: a marker grows across each line, then slides off
 *    while the words appear behind it (IntersectionObserver, staggered)
 *  - scroll-fill bodies: quiet paragraphs fill from 5% ink as they cross
 *    the viewport, scrubbed by a rAF loop reading live scroll position
 *  - the tour lens: a cursor-following crosshair whose coordinates print
 *    in hex, inside the dark console band
 *  - the banner: yields against downward scroll, and a hairline under it
 *    carries document progress
 *
 * prefers-reduced-motion turns all of it off and the reader gets the
 * plain page. Without JavaScript the copy is simply there (the
 * <noscript> style in layout keeps it visible). Nothing here changes
 * content; every number still reads the same.
 */
export default function Motion() {
  useEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const fine =
      window.matchMedia("(pointer: fine)").matches;
    const cleanups: Array<() => void> = [];

    /* ---------- 1, headline wipes ---------- */

    if (!reduced) {
      const wipes = document.querySelectorAll<HTMLElement>(
        '[data-anim="wipe"]',
      );
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              (e.target as HTMLElement).classList.add("wipe-in");
              io.unobserve(e.target);
            }
          }
        },
        { rootMargin: "0px 0px -12% 0px", threshold: 0 },
      );
      wipes.forEach((h) => io.observe(h));
      cleanups.push(() => io.disconnect());
    }

    /* ---------- 2, scroll-fill bodies ---------- */

    const fills: Array<{
      el: HTMLElement;
      words: HTMLElement[];
    }> = [];

    if (!reduced) {
      document.querySelectorAll<HTMLElement>("[data-fill]").forEach((p) => {
        const words: HTMLElement[] = [];
        const walk = (node: Node, cls: string) => {
          if (
            node.nodeType === Node.TEXT_NODE &&
            node.textContent &&
            node.textContent.trim().length
          ) {
            const frag = document.createDocumentFragment();
            const parts = node.textContent.split(/(\s+)/);
            for (const part of parts) {
              if (!part.length) continue;
              if (/^\s+$/.test(part)) {
                frag.appendChild(document.createTextNode(" "));
              } else {
                const s = document.createElement("span");
                s.className = cls;
                s.textContent = part;
                words.push(s);
                frag.appendChild(s);
              }
            }
            node.parentNode?.replaceChild(frag, node);
          } else if (node.nodeType === Node.ELEMENT_NODE && node.childNodes) {
            node.childNodes.forEach((c) => walk(c, cls));
          }
        };
        p.childNodes.forEach((c) => walk(c, "fill-w"));
        fills.push({ el: p, words });
      });
    }

    /* ---------- shared rAF: fill scrub + banner hairline ---------- */

    let raf = 0;
    let lastY = window.scrollY;
    let lastHeaderY = window.scrollY;
    const root = document.documentElement;
    let progress = 0;

    const header = document.querySelector<HTMLElement>(".site-header");

    const loop = () => {
      const vh = window.innerHeight;

      // fill scrub: words wake paragraph by paragraph
      for (const f of fills) {
        const rc = f.el.getBoundingClientRect();
        if (rc.bottom < -40 || rc.top > vh + 40) continue;
        const start = vh * 0.92;
        const end = vh * 0.62 - rc.height;
        const span = Math.max(1, start - end);
        const p = Math.min(1, Math.max(0, (start - rc.top) / span));
        const n = f.words.length;
        for (let i = 0; i < n; i++) {
          const local = Math.min(1, Math.max(0, p * n - i));
          f.words[i].style.opacity = (0.05 + local * 0.95).toFixed(3);
        }
      }

      // banner hairline: document progress
      const doc =
        document.documentElement.scrollHeight - window.innerHeight;
      if (Math.abs(window.scrollY - lastY) > 0.5) {
        progress = doc > 0 ? Math.min(1, Math.max(0, window.scrollY / doc)) : 0;
        root.style.setProperty("--doc-prog", progress.toFixed(4));
        lastY = window.scrollY;
      }

      // banner folds back against downward scroll (tresmares grammar)
      if (header) {
        const y = window.scrollY;
        if (y > 150 && y > lastHeaderY + 6) {
          header.classList.add("header--fold");
          lastHeaderY = y;
        } else if (y < lastHeaderY - 6 || y <= 150) {
          header.classList.remove("header--fold");
          lastHeaderY = y;
        }
      }

      // tour lens follows, damped
      if (lens.active) {
        lens.cx += (lens.tx - lens.cx) * 0.16;
        lens.cy += (lens.ty - lens.cy) * 0.16;
        if (lens.v)
          lens.v.style.transform = `translateX(${lens.cx.toFixed(1)}px)`;
        if (lens.h)
          lens.h.style.transform = `translateY(${lens.cy.toFixed(1)}px)`;
        if (lens.dot)
          lens.dot.style.transform = `translate(${lens.cx.toFixed(1)}px, ${lens.cy.toFixed(1)}px)`;
        if (lens.chip)
          lens.chip.style.transform = `translate(${(lens.cx + 14).toFixed(1)}px, ${(lens.cy + 18).toFixed(1)}px)`;
        if (lens.chip) updateChip();
      }

      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    cleanups.push(() => window.cancelAnimationFrame(raf));

    /* ---------- 3, the tour lens (cursor crosshair) ---------- */

    type Lens = {
      host: HTMLElement | null;
      v: HTMLElement | null;
      h: HTMLElement | null;
      dot: HTMLElement | null;
      chip: HTMLElement | null;
      active: boolean;
      tx: number;
      ty: number;
      cx: number;
      cy: number;
      onMove: (e: PointerEvent) => void;
      onLeave: () => void;
    };

    const lens: Lens = {
      host: null,
      v: null,
      h: null,
      dot: null,
      chip: null,
      active: false,
      tx: 0,
      ty: 0,
      cx: 0,
      cy: 0,
      onMove: () => {},
      onLeave: () => {},
    };

    const updateChip = () => {
      if (lens.chip) {
        const x = Math.max(0, Math.round(lens.cx)).toString(16);
        const y = Math.max(0, Math.round(lens.cy)).toString(16);
        lens.chip.textContent = `0x${x.padStart(4, "0")} · 0x${y.padStart(4, "0")}`;
      }
    };

    if (!reduced && fine) {
      const tour = document.querySelector<HTMLElement>(".tour");
      if (tour) {
        const lensEl = document.createElement("div");
        lensEl.className = "lens";
        lensEl.setAttribute("aria-hidden", "true");
        lensEl.innerHTML =
          '<span class="lens__v"></span><span class="lens__h"></span><span class="lens__dot"></span><span class="lens__chip mono">0x0000 · 0x0000</span>';
        tour.appendChild(lensEl);

        lens.host = tour;
        lens.v = lensEl.querySelector<HTMLElement>(".lens__v");
        lens.h = lensEl.querySelector<HTMLElement>(".lens__h");
        lens.dot = lensEl.querySelector<HTMLElement>(".lens__dot");
        lens.chip = lensEl.querySelector<HTMLElement>(".lens__chip");

        lens.onMove = (e: PointerEvent) => {
          const rc = (lens.host as HTMLElement).getBoundingClientRect();
          lens.tx = e.clientX - rc.left;
          lens.ty = e.clientY - rc.top;
          if (!lens.active) lensEl.classList.add("lens--on");
          lens.active = true;
        };
        lens.onLeave = () => lensEl.classList.remove("lens--on");

        tour.addEventListener("pointermove", lens.onMove, { passive: true });
        tour.addEventListener("pointerleave", lens.onLeave, { passive: true });
        cleanups.push(() => {
          tour.removeEventListener("pointermove", lens.onMove);
          tour.removeEventListener("pointerleave", lens.onLeave);
          lensEl.remove();
        });
      }
    }

    /* ---------- 4, eased anchors ---------- */

    if (!reduced) {
      const easeInOutExpo = (t: number) =>
        t < 0.5
          ? 0.5 * Math.pow(2, 20 * t - 10)
          : 1 - 0.5 * Math.pow(2, -20 * t + 10);

      const onClick = (e: MouseEvent) => {
        const a = (e.target as HTMLElement)?.closest?.("a");
        if (!a) return;
        const href = a.getAttribute("href");
        if (!href || !href.startsWith("#") || href.length < 2) return;
        const target = document.getElementById(href.slice(1));
        if (!target) return;
        e.preventDefault();
        const y0 = window.scrollY;
        const y1 =
          target.getBoundingClientRect().top +
          window.scrollY -
          58; /* the banner */
        const d = Math.min(1100, Math.max(650, Math.abs(y1 - y0) * 0.42));
        const t0 = performance.now();
        let killed = false;
        const kill = () => {
          killed = true;
        };
        window.addEventListener("wheel", kill, { passive: true, once: true });
        window.addEventListener("touchstart", kill, { passive: true, once: true });
        const step = (t: number) => {
          if (killed) return;
          const p = Math.min(1, (t - t0) / d);
          /* "instant" rather than the document's smooth behavior: the tween
             IS the ease; per-tick smooth scrolls would reprogram
             Chrome's async smooth anim every frame and damp to mud */
          window.scrollTo({ top: y0 + (y1 - y0) * easeInOutExpo(p), behavior: "instant" });
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        history.replaceState(null, "", href);
      };
      document.addEventListener("click", onClick);
      cleanups.push(() => document.removeEventListener("click", onClick));
    }

    /* ---------- done ---------- */

    return () => {
      cleanups.forEach((c) => c());
      fills.forEach((f) =>
        f.words.forEach((w) => {
          w.style.opacity = "";
        }),
      );
    };
  }, []);

  return null;
}
