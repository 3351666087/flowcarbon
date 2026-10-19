"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Camera, ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/auth-flow";
import { feel } from "@/components/glass";
import { Sheet } from "@/components/sheet";
import { toast } from "@/components/toast";
import { Button, ErrorBox } from "@/components/ui";
import { api, unwrap } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/** the cropping window, and the size the picture is saved at */
const VIEW = 260;
const OUT = 256;

interface Picked {
  img: HTMLImageElement;
  url: string;
}

/**
 * Your picture: shown large, with a way to choose a new one or go back to initials. A chosen photo is cropped to a
 * circle here (drag to place it, slide or pinch to zoom), resized to 256 px in the browser and saved.
 */
export function AvatarSheet({
  user,
  onClose,
}: {
  user: { name: string; email: string; avatarUrl: string | null };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const a = t.account;

  useEffect(
    () => () => {
      if (picked) URL.revokeObjectURL(picked.url);
    },
    [picked],
  );

  const choose = (file: File) => {
    setError(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setPicked({ img, url });
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError(new Error(a.notImage));
    };
    img.src = url;
  };

  // the picture always covers the circle: its smaller side fills the window at zoom 1
  const base = picked ? VIEW / Math.min(picked.img.naturalWidth, picked.img.naturalHeight) : 1;
  const scale = base * zoom;
  const clamp = (o: { x: number; y: number }, z = zoom) => {
    if (!picked) return o;
    const s = base * z;
    const maxX = Math.max(0, (picked.img.naturalWidth * s - VIEW) / 2);
    const maxY = Math.max(0, (picked.img.naturalHeight * s - VIEW) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, o.x)), y: Math.max(-maxY, Math.min(maxY, o.y)) };
  };
  const zoomTo = (z: number) => {
    const next = Math.max(1, Math.min(4, z));
    setZoom(next);
    setOffset((o) => clamp(o, next));
  };

  const save = async (close: () => void) => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const { img } = picked;
      const canvas = document.createElement("canvas");
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext("2d")!;
      const sx = (img.naturalWidth * scale) / 2 - VIEW / 2 - offset.x;
      const sy = (img.naturalHeight * scale) / 2 - VIEW / 2 - offset.y;
      ctx.drawImage(img, sx / scale, sy / scale, VIEW / scale, VIEW / scale, 0, 0, OUT, OUT);
      let image = canvas.toDataURL("image/webp", 0.86);
      if (!image.startsWith("data:image/webp")) image = canvas.toDataURL("image/jpeg", 0.88);
      await unwrap(api.PUT("/api/v1/me/avatar", { body: { image } }));
      feel("confirm");
      await qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["device-accounts"] });
      toast(a.avatarSaved);
      close();
    } catch (e) {
      feel("reject");
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (close: () => void) => {
    setBusy(true);
    try {
      await unwrap(api.DELETE("/api/v1/me/avatar"));
      feel("press");
      await qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["device-accounts"] });
      toast(a.avatarRemoved);
      close();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={a.avatarTitle}
      onClose={onClose}
      footer={
        picked
          ? (close) => (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1 justify-center"
                  onClick={() => input.current?.click()}
                >
                  {a.repick}
                </Button>
                <Button
                  variant="primary"
                  className="flex-1 justify-center"
                  busy={busy}
                  onClick={() => save(close)}
                >
                  {a.save}
                </Button>
              </div>
            )
          : undefined
      }
    >
      {(close) => (
        <>
          <input
            ref={input}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) choose(file);
              e.target.value = "";
            }}
          />
          {picked ? (
            <div className="flex flex-col items-center">
              <div
                className="relative touch-none overflow-hidden rounded-[28px] bg-surface-2 select-none"
                style={{ width: VIEW, height: VIEW, cursor: "grab" }}
                onWheel={(e) => zoomTo(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                  if (pointers.current.size === 2) {
                    const [p, q] = [...pointers.current.values()];
                    pinch.current = { distance: Math.hypot(p!.x - q!.x, p!.y - q!.y), zoom };
                  }
                }}
                onPointerMove={(e) => {
                  const last = pointers.current.get(e.pointerId);
                  if (!last) return;
                  pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                  if (pointers.current.size === 2 && pinch.current) {
                    const [p, q] = [...pointers.current.values()];
                    zoomTo(
                      (pinch.current.zoom * Math.hypot(p!.x - q!.x, p!.y - q!.y)) / pinch.current.distance,
                    );
                    return;
                  }
                  setOffset((o) => clamp({ x: o.x + e.clientX - last.x, y: o.y + e.clientY - last.y }));
                }}
                onPointerUp={(e) => {
                  pointers.current.delete(e.pointerId);
                  if (pointers.current.size < 2) pinch.current = null;
                }}
              >
                <img
                  src={picked.url}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute max-w-none"
                  style={{
                    width: picked.img.naturalWidth * scale,
                    height: picked.img.naturalHeight * scale,
                    left: VIEW / 2 - (picked.img.naturalWidth * scale) / 2 + offset.x,
                    top: VIEW / 2 - (picked.img.naturalHeight * scale) / 2 + offset.y,
                  }}
                />
                {/* everything outside the circle is dimmed: that part is cut away */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgb(0_0_0/0.45)] ring-2 ring-white/70"
                />
              </div>
              <input
                type="range"
                min={1}
                max={4}
                step={0.01}
                value={zoom}
                aria-label={a.zoom}
                onChange={(e) => zoomTo(Number(e.target.value))}
                className="mt-4 w-[260px] accent-[var(--accent)]"
              />
              <p className="mt-2 text-xs text-muted">{a.cropHint}</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-2">
              <Avatar name={user.name} email={user.email} src={user.avatarUrl} size={112} />
              <div className="flex w-full flex-col gap-2">
                <Button
                  variant="primary"
                  className="w-full justify-center"
                  onClick={() => input.current?.click()}
                >
                  <ImagePlus className="size-4" aria-hidden /> {a.choosePhoto}
                </Button>
                {user.avatarUrl ? (
                  <Button
                    variant="ghost"
                    className="w-full justify-center text-danger"
                    busy={busy}
                    onClick={() => remove(close)}
                  >
                    <Trash2 className="size-4" aria-hidden /> {a.removePhoto}
                  </Button>
                ) : null}
              </div>
            </div>
          )}
          {error ? (
            <div className="mt-3">
              <ErrorBox error={error} />
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}

/** The camera badge on your avatar in the account menu, saying it can be changed. */
export function AvatarBadge() {
  return (
    <span className="absolute -right-0.5 -bottom-0.5 grid size-5 place-items-center rounded-full bg-accent text-white ring-2 ring-[var(--surface)]">
      <Camera className="size-3" aria-hidden />
    </span>
  );
}
