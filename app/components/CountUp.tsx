"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Renders a number that counts up once the element scrolls into view.
 * Reduced-motion readers get the final value immediately, the count is
 * decoration; the number is the point.
 */
export default function CountUp({
  to,
  decimals = 0,
  suffix = "",
  duration = 1500,
}: {
  to: number;
  decimals?: number;
  suffix?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [val, setVal] = useState(0);
  const armed = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVal(to);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting || armed.current) continue;
          armed.current = true;
          io.disconnect();

          const t0 = performance.now();
          const tick = (t: number) => {
            const p = Math.min(1, (t - t0) / duration);
            const eased = 1 - Math.pow(1 - p, 3);
            setVal(to * eased);
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          break;
        }
      },
      { threshold: 0.5 },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [to, duration]);

  return (
    <span ref={ref} className="countup">
      {val.toFixed(decimals)}
      {suffix}
    </span>
  );
}
