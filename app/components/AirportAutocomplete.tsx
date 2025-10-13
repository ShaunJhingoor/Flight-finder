// components/AirportAutocomplete.tsx
"use client";

import { useEffect, useRef, useState } from "react";

type Option = {
  type: "CITY" | "AIRPORT";
  code: string;
  name: string;
  city: string;
  country: string;
};

export default function AirportAutocomplete(props: {
  nameCode: string;
  label: string;
  placeholder?: string;
  defaultDisplay?: string;
  defaultCode?: string;
  required?: boolean;
}) {
  const {
    nameCode,
    label,
    placeholder,
    defaultDisplay,
    defaultCode,
    required,
  } = props;
  const [input, setInput] = useState(defaultDisplay || "");
  const [code, setCode] = useState(defaultCode || "");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Option[]>([]);
  const [active, setActive] = useState<number>(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressNextFetch = useRef(false);

  // Debounce user typing
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(input.trim()), 300);
    return () => clearTimeout(id);
  }, [input]);

  // Fetch suggestions
  useEffect(() => {
    let ignore = false;
    async function run() {
      if (suppressNextFetch.current) {
        // consume the suppression once
        suppressNextFetch.current = false;
        return;
      }
      if (!q || q.length < 2) {
        setOptions([]);
        return;
      }
      const res = await fetch(`/api/airports?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      console.log("json", json);
      if (!ignore) {
        const focused = document.activeElement === inputRef.current;
        setOptions(json.results || []);
        setOpen(focused && (json.results?.length ?? 0) > 0);
        setActive(-1);
      }
    }
    run();
    return () => {
      ignore = true;
    };
  }, [q]);

  // Close when clicking outside
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function choose(opt: Option) {
    setInput(opt.code);
    setCode(opt.code);
    suppressNextFetch.current = true;
    setOptions([]);
    setOpen(false);
    setActive(-1);
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || options.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const i = active >= 0 ? active : 0;
      choose(options[i]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showRequired = required ? { required: true } : {};
  const displayPlaceholder =
    placeholder ?? "City or airport (e.g., New York, JFK)";

  return (
    <div className="relative" ref={boxRef}>
      <label className="text-sm block mb-1">{label}</label>
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setCode("");
        }}
        onFocus={() => {
          if (options.length > 0 && !code) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        placeholder={displayPlaceholder}
        className="w-full border p-2 rounded"
        {...showRequired}
        autoComplete="off"
      />
      {/* hidden IATA code field that your form posts */}
      <input type="hidden" name={nameCode} value={code} />

      {open && options.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded border bg-amber-50 shadow text-zinc-900">
          {options.map((opt, i) => (
            <li
              key={`${opt.type}-${opt.code}-${i}`}
              role="option"
              aria-selected={active === i}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(opt);
              }}
              className={`cursor-pointer px-3 py-2 text-sm hover:bg-gray-100 ${
                active === i ? "bg-gray-100" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="font-medium">
                  {opt.city}
                  {opt.city !== opt.name ? ` — ${opt.name}` : ""}{" "}
                  <span className="opacity-60">({opt.code})</span>
                </div>
                <span className="text-xs rounded px-2 py-0.5 border opacity-70">
                  {opt.type}
                </span>
              </div>
              <div className="text-xs opacity-70">{opt.country}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
