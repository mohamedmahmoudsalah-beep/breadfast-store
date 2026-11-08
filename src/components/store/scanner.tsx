"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };

/** Camera scanning (BarcodeDetector, Chrome/Android/Edge). A hardware scanner or typing works through the text box. */
export function CameraScanner({ onScan, label = "مسح بالكاميرا" }: { onScan: (code: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const cb = useRef(onScan);
  useEffect(() => { cb.current = onScan; });

  useEffect(() => {
    if (!open) return;
    let stop = false; let stream: MediaStream | null = null; let timer: number | undefined;
    (async () => {
      const BD = (window as unknown as { BarcodeDetector?: new (o?: { formats: string[] }) => Detector }).BarcodeDetector;
      if (!BD) { setMsg("المتصفح لا يدعم المسح بالكاميرا. استخدم جهاز المسح أو اكتب الكود."); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        const detector = new BD();
        let last = "";
        const tick = async () => {
          if (stop || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            const v = codes[0]?.rawValue;
            if (v && v !== last) { last = v; cb.current(v); setTimeout(() => { last = ""; }, 1500); }
          } catch { /* ignore frame errors */ }
          timer = window.setTimeout(tick, 250);
        };
        void tick();
      } catch { setMsg("تعذر تشغيل الكاميرا. اسمح بالوصول للكاميرا من المتصفح."); }
    })();
    return () => { stop = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [open]);

  return (
    <div>
      <Button type="button" variant="secondary" onClick={() => { setMsg(""); setOpen((o) => !o); }}>{open ? "إغلاق الكاميرا" : label}</Button>
      {open && (
        <div className="mt-3 overflow-hidden rounded-2xl bg-black">
          <video ref={video} playsInline muted className="max-h-64 w-full object-cover" />
        </div>
      )}
      {msg && <p className="mt-2 text-sm text-warning">{msg}</p>}
    </div>
  );
}
