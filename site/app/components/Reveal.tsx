"use client";

import { useEffect, useRef } from "react";

/**
 * Adds .in once the element scrolls into view (IntersectionObserver),
 * one-way: the observer disconnects after answering. Without JS the
 * <noscript> style in layout makes reveals visible instead of lost.
 */
export default function Reveal({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add("in");
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.16 },
    );
    io.observe(el);
    return () => io.disconnect();
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
