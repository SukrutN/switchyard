"use client";

import { useEffect, useRef } from "react";

/**
 * Adds .in once the element's top passes the viewport bottom, however
 * fast it got there: a flick, a Page-down, or an anchor jump all count,
 * because the check reads the element's own position on every scroll
 * frame - an element that skipped past the viewport without ever
 * intersecting it still reveals. Without JS the <noscript> style in
 * layout makes reveals visible instead of lost.
 */
export default function Reveal({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = window.setTimeout(() => el.classList.add("in"), 0);
      return () => window.clearTimeout(id);
    }
    let raf = 0;
    const check = () => {
      raf = 0;
      if (done.current) return;
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight) {
        done.current = true;
        el.classList.add("in");
      }
    };
    const onScroll = () => {
      if (raf === 0 && !done.current) raf = window.requestAnimationFrame(check);
    };
    raf = window.requestAnimationFrame(check);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf !== 0) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="reveal"
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
