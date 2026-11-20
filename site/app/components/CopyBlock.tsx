"use client";

import { useRef, useState } from "react";

/** A quickstart block with a copy button. Honest by construction:
 * the text copied is exactly the text printed. */
export default function CopyBlock({
  code,
  label,
}: {
  code: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard refused (permissions/etc.), the text is selectable
      // either way, so nothing breaks.
    }
  };

  return (
    <div className="copyblock mono">
      {label ? <span className="copyblock__tag">{label}</span> : null}
      <button
        type="button"
        className="copyblock__btn"
        onClick={copy}
        aria-label={`copy: ${code}`}
      >
        {copied ? "COPIED ✓" : "COPY"}
      </button>
      <pre className="copyblock__code">{code}</pre>
    </div>
  );
}
