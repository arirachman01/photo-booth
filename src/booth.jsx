/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Camera,
  Check,
  RotateCcw,
  ArrowRight,
  AlertCircle,
  QrCode,
  Sparkles,
  Printer,
  FlipHorizontal,
} from "lucide-react";
import GIF from "gif.js";
const GIFJS_WORKER_URL = new URL("gif.js/dist/gif.worker.js", import.meta.url)
  .href;

const COLORS = {
  bg: "#ffffff",
  bgSoft: "#fafafa",
  panel: "#ffffff",
  panelLine: "#e2e2e2",
  ivory: "#111111",
  ivoryDim: "#3a3a3a",
  gold: "#111111",
  goldSoft: "#111111",
  ink: "#ffffff",
  muted: "#8a8a8a",
};

const SERIF = '"Cormorant Garamond", serif';
const SANS = '"Jost", sans-serif';

const TOTAL_SHOTS = 6;

/* harga cetak fisik per lembar (dummy) */
const PRINT_PRICE_PER_COPY = 15000;
/* batas jumlah lembar yang bisa dipesan dalam satu sesi cetak */
const PRINT_QTY_MAX = 20;

/* total seconds the guest has, starting right after payment, to finish
   permission → capture → review. If this runs out while they're still on
   permission/capture/review, we skip straight to the filter step and
   drop any retake/re-shoot in progress. If they reach the filter step
   before it runs out, the timer is simply cleared — normal flow. */
const SESSION_TIME_LIMIT_SEC = 60;

/* max width/height (px) a frame PNG is downscaled to before use — keeps
   canvas rendering fast even if someone drops in a huge source file */
const MAX_FRAME_IMG_DIM = 1600;

/* ================= shared step header atoms ================= */
function StepEyebrow({ children }) {
  return (
    <div
      className="text-center"
      style={{
        fontSize: 11,
        letterSpacing: "0.22em",
        textTransform: "uppercase",
        color: COLORS.muted,
      }}
    >
      {children}
    </div>
  );
}

function StepTitle({ children }) {
  return (
    <h2
      className="text-center mt-1.5"
      style={{
        fontFamily: SERIF,
        color: COLORS.ivory,
        fontWeight: 500,
        fontSize: 26,
        lineHeight: 1.2,
      }}
    >
      {children}
    </h2>
  );
}

function PrimaryButton({ children, onClick, disabled, icon: Icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full mt-10 flex items-center justify-center gap-2 py-3 transition-opacity"
      style={{
        background: disabled ? COLORS.panelLine : COLORS.gold,
        color: disabled ? COLORS.muted : COLORS.ink,
        fontFamily: SANS,
        fontSize: 13.5,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        borderRadius: "12px",
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
      {Icon ? <Icon size={16} /> : null}
    </button>
  );
}

/* ================= geometry helpers (pure, canvas 2D) ================= */
function roundRectPath(ctx, x, y, w, h, r) {
  if (!r) {
    ctx.rect(x, y, w, h);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
}

function clipSlot(ctx, slot) {
  ctx.beginPath();
  if (slot.shape === "circle") {
    ctx.ellipse(
      slot.x + slot.w / 2,
      slot.y + slot.h / 2,
      slot.w / 2,
      slot.h / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else {
    roundRectPath(ctx, slot.x, slot.y, slot.w, slot.h, slot.radius || 0);
  }
  ctx.closePath();
  ctx.clip();
}

function strokeSlot(ctx, slot, color, width) {
  ctx.save();
  ctx.beginPath();
  if (slot.shape === "circle") {
    ctx.ellipse(
      slot.x + slot.w / 2,
      slot.y + slot.h / 2,
      slot.w / 2,
      slot.h / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else {
    roundRectPath(ctx, slot.x, slot.y, slot.w, slot.h, slot.radius || 0);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

function pointInSlot(px, py, slot) {
  if (slot.shape === "circle") {
    const cx = slot.x + slot.w / 2,
      cy = slot.y + slot.h / 2,
      rx = slot.w / 2,
      ry = slot.h / 2;
    const dx = (px - cx) / rx,
      dy = (py - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return (
    px >= slot.x &&
    px <= slot.x + slot.w &&
    py >= slot.y &&
    py <= slot.y + slot.h
  );
}

function clampSlotState(slot, ss, img) {
  if (!img) return;
  const baseScale = Math.max(slot.w / img.width, slot.h / img.height);
  const scale = baseScale * ss.zoom;
  const dw = img.width * scale,
    dh = img.height * scale;
  const maxOffX = Math.max(0, (dw - slot.w) / 2);
  const maxOffY = Math.max(0, (dh - slot.h) / 2);
  ss.offsetX = Math.min(maxOffX, Math.max(-maxOffX, ss.offsetX));
  ss.offsetY = Math.min(maxOffY, Math.max(-maxOffY, ss.offsetY));
}

function drawFilteredInto(ctx, img, cssFilter, w, h) {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  try {
    ctx.filter = cssFilter;
  } catch (e) {
    console.log(e);
  }
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale,
    dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.restore();
}

function renderTemplateChipPreview(canvas, T) {
  const f = 0.09;
  canvas.width = Math.round(T.width * f);
  canvas.height = Math.round(T.height * f);
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.scale(f, f);
  T.drawBg(ctx, T);
  T.slots.forEach((slot) => {
    ctx.save();
    clipSlot(ctx, slot);
    ctx.fillStyle = "rgba(198,162,92,0.14)";
    ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
    ctx.restore();
    strokeSlot(ctx, slot, "rgba(198,162,92,0.8)", 3);
  });
  T.drawFg(ctx, T);
  ctx.restore();
}

function autofillEmptySlots(slotsArr, photosList) {
  const used = {};
  slotsArr.forEach((s) => {
    if (s.photoIndex !== null) used[s.photoIndex] = true;
  });
  for (let i = 0; i < photosList.length; i++) {
    if (used[i]) continue;
    const target = slotsArr.find((s) => s.photoIndex === null);
    if (!target) break;
    target.photoIndex = i;
    target.zoom = 1;
    target.offsetX = 0;
    target.offsetY = 0;
    used[i] = true;
  }
}

function rebuildSlotStatesFor(templatesList, templateId, photosList) {
  const T = templatesList.find((t) => t.id === templateId) || templatesList[0];
  const blank = T.slots.map(() => ({
    photoIndex: null,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  }));
  autofillEmptySlots(blank, photosList);
  return blank;
}

const BUILTIN_FRAME_SPECS = [
  {
    id: "frame-1",
    name: "Frame 1",
    layout: "grid",
    count: 1,
    shape: "rect",
    rounded: true,
    accentColor: "#c6a25c",
    frameColor: "#f3ead9",
    cardColor: "#0c0a08",
  },
];
// console.log(BUILTIN_FRAME_SPECS);

/* builtin templates are generated the same way as user-made frames, just
   flagged isCustom:false so they don't show the "SENDIRI" tag / delete icon */
const BUILTIN_TEMPLATES = BUILTIN_FRAME_SPECS.map((spec) => ({
  ...buildCustomTemplate(spec),
  isCustom: false,
}));

const frameImageCache = new Map();

function getFrameImage(dataUrl, notifyReady) {
  if (!dataUrl) return null;
  let img = frameImageCache.get(dataUrl);
  if (!img) {
    img = new Image();
    img.src = dataUrl;
    frameImageCache.set(dataUrl, img);
  }
  if (img.complete && img.naturalWidth > 0) return img;
  if (notifyReady) img.addEventListener("load", notifyReady, { once: true });
  return null;
}

function detectTransparentRegions(
  img,
  width,
  height,
  alphaThreshold = 250,
  minAreaFrac = 0.003,
) {
  try {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const total = width * height;
    const isHole = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      isHole[i] = data[i * 4 + 3] < alphaThreshold ? 1 : 0;
    }
    const visited = new Uint8Array(total);
    const stackX = new Int32Array(total);
    const stackY = new Int32Array(total);
    const minArea = Math.max(16, total * minAreaFrac);
    const regions = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (visited[idx] || !isHole[idx]) continue;
        let sp = 0;
        stackX[sp] = x;
        stackY[sp] = y;
        sp++;
        visited[idx] = 1;
        let minX = x,
          maxX = x,
          minY = y,
          maxY = y,
          area = 0;
        while (sp > 0) {
          sp--;
          const cx = stackX[sp],
            cy = stackY[sp];
          area++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          if (cx + 1 < width) {
            const ni = cy * width + (cx + 1);
            if (!visited[ni] && isHole[ni]) {
              visited[ni] = 1;
              stackX[sp] = cx + 1;
              stackY[sp] = cy;
              sp++;
            }
          }
          if (cx - 1 >= 0) {
            const ni = cy * width + (cx - 1);
            if (!visited[ni] && isHole[ni]) {
              visited[ni] = 1;
              stackX[sp] = cx - 1;
              stackY[sp] = cy;
              sp++;
            }
          }
          if (cy + 1 < height) {
            const ni = (cy + 1) * width + cx;
            if (!visited[ni] && isHole[ni]) {
              visited[ni] = 1;
              stackX[sp] = cx;
              stackY[sp] = cy + 1;
              sp++;
            }
          }
          if (cy - 1 >= 0) {
            const ni = (cy - 1) * width + cx;
            if (!visited[ni] && isHole[ni]) {
              visited[ni] = 1;
              stackX[sp] = cx;
              stackY[sp] = cy - 1;
              sp++;
            }
          }
        }
        if (area >= minArea) {
          regions.push({
            x: minX,
            y: minY,
            w: maxX - minX + 1,
            h: maxY - minY + 1,
            area,
          });
        }
      }
    }
    const rowTolerance = height * 0.06;
    regions.sort((a, b) => {
      const ay = a.y + a.h / 2,
        by = b.y + b.h / 2;
      if (Math.abs(ay - by) > rowTolerance) return ay - by;
      return a.x + a.w / 2 - (b.x + b.w / 2);
    });
    return regions;
  } catch (e) {
    console.log(e);
    return [];
  }
}

/* ================= folder-based frame templates (Vite) =================
   Drop any transparent PNG into src/assets/frames/ and it shows up
   automatically as a built-in frame template — no code changes needed.
   Transparent areas are auto-detected the same way as a "Buat Bingkai
   Sendiri" upload, so photos land in the right spot on their own. */
const FRAME_FOLDER_MODULES = import.meta.glob("./assets/frames/*.png", {
  eager: true,
});

function loadImageAsync(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function frameNameFromPath(path) {
  const file = path
    .split("/")
    .pop()
    .replace(/\.png$/i, "");
  return file.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* mirrors handleBuilderImageSelect's pipeline (downscale → cache → detect
   transparent holes) but runs against a bundled asset URL instead of a
   FileReader result, so folder frames behave identically to uploaded ones */
async function buildFolderFrameSpec(path, url) {
  try {
    const probe = await loadImageAsync(url);
    let width = probe.naturalWidth,
      height = probe.naturalHeight;
    let finalUrl = url;
    if (Math.max(width, height) > MAX_FRAME_IMG_DIM) {
      const scale = MAX_FRAME_IMG_DIM / Math.max(width, height);
      const w = Math.round(width * scale),
        h = Math.round(height * scale);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(probe, 0, 0, w, h);
      finalUrl = c.toDataURL("image/png");
      width = w;
      height = h;
    }
    const cached = await loadImageAsync(finalUrl);
    frameImageCache.set(finalUrl, cached);
    const regions = detectTransparentRegions(cached, width, height);
    const hasHole = regions.length > 0;
    let holeX = 0,
      holeY = 0,
      holeW = width,
      holeH = height;
    if (hasHole) {
      holeX = Math.min(...regions.map((r) => r.x));
      holeY = Math.min(...regions.map((r) => r.y));
      holeW = Math.max(...regions.map((r) => r.x + r.w)) - holeX;
      holeH = Math.max(...regions.map((r) => r.y + r.h)) - holeY;
    }
    return {
      id: `folder-${path}`,
      name: frameNameFromPath(path),
      type: "image",
      imageDataUrl: finalUrl,
      imgW: width,
      imgH: height,
      hasHole,
      holeX,
      holeY,
      holeW,
      holeH,
      holes: regions,
      count: hasHole ? Math.max(1, Math.min(6, regions.length)) : 1,
    };
  } catch (e) {
    console.log("Gagal memuat bingkai dari folder:", path, e);
    return null;
  }
}

function sliceBoundsIntoSlots(bounds, count) {
  const n = Math.max(1, count || 1);
  const bandH = bounds.h / n;
  return Array.from({ length: n }, (_, i) => ({
    x: bounds.x,
    y: bounds.y + i * bandH,
    w: bounds.w,
    h: bandH,
  }));
}

function buildCustomTemplate(spec, notifyImageReady) {
  if (spec.type === "image") {
    const { id, name, imageDataUrl, imgW, imgH } = spec;
    const width = imgW || 1000;
    const height = imgH || 1000;
    const hasHole = !!spec.hasHole;
    const n = Math.max(1, Math.min(6, spec.count || 1));
    const detectedHoles = Array.isArray(spec.holes) ? spec.holes : [];
    let slots;
    let usedDetectedHoles = false;
    if (detectedHoles.length === n) {
      slots = detectedHoles.map((h) => ({
        x: h.x,
        y: h.y,
        w: h.w,
        h: h.h,
        shape: "rect",
        radius: 0,
      }));
      usedDetectedHoles = true;
    } else {
      const bounds = hasHole
        ? { x: spec.holeX, y: spec.holeY, w: spec.holeW, h: spec.holeH }
        : { x: 0, y: 0, w: width, h: height };
      slots = sliceBoundsIntoSlots(bounds, n).map((s) => ({
        ...s,
        shape: "rect",
        radius: 0,
      }));
    }
    return {
      id,
      name,
      meta: `${n} foto · gambar sendiri${usedDetectedHoles ? "" : hasHole ? "" : " (penuh)"}`,
      width,
      height,
      slots,
      isCustom: true,
      spec,
      drawBg: function () {},
      drawFg: function (ctx, T) {
        const img = getFrameImage(imageDataUrl, notifyImageReady);
        if (img) ctx.drawImage(img, 0, 0, T.width, T.height);
      },
    };
  }
  const {
    id,
    name,
    layout,
    count,
    shape,
    rounded,
    accentColor,
    frameColor,
    cardColor,
  } = spec;
  const n = Math.max(1, Math.min(6, count || 1));
  const radius = rounded ? 24 : 0;
  const outerMargin = 60;
  const gap = 32;
  const captionH = 170;
  let width, height, slots;

  if (layout === "row") {
    const slotW = 520,
      slotH = 720;
    height = outerMargin * 2 + slotH + captionH;
    width = outerMargin * 2 + n * slotW + (n - 1) * gap;
    slots = Array.from({ length: n }).map((_, i) => ({
      x: outerMargin + i * (slotW + gap),
      y: outerMargin,
      w: slotW,
      h: slotH,
      shape,
      radius,
    }));
  } else if (layout === "grid") {
    const cols = n <= 2 ? n : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    const slotW = 540,
      slotH = 540;
    width = outerMargin * 2 + cols * slotW + (cols - 1) * gap;
    height = outerMargin * 2 + rows * slotH + (rows - 1) * gap + captionH;
    slots = Array.from({ length: n }).map((_, i) => {
      const r = Math.floor(i / cols),
        c = i % cols;
      return {
        x: outerMargin + c * (slotW + gap),
        y: outerMargin + r * (slotH + gap),
        w: slotW,
        h: slotH,
        shape,
        radius,
      };
    });
  } else {
    /* column */
    const slotW = 740,
      slotH = 460;
    width = outerMargin * 2 + slotW;
    height = outerMargin * 2 + n * slotH + (n - 1) * gap + captionH;
    slots = Array.from({ length: n }).map((_, i) => ({
      x: outerMargin,
      y: outerMargin + i * (slotH + gap),
      w: slotW,
      h: slotH,
      shape,
      radius,
    }));
  }

  return {
    id,
    name,
    meta: `${n} foto`,
    width,
    height,
    slots,
    isCustom: true,
    spec,
    drawBg: function (ctx, T) {
      ctx.fillStyle = cardColor;
      ctx.fillRect(0, 0, T.width, T.height);
      ctx.fillStyle = frameColor;
      ctx.beginPath();
      roundRectPath(ctx, 18, 18, T.width - 36, T.height - 36, rounded ? 18 : 0);
      ctx.fill();
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      roundRectPath(ctx, 34, 34, T.width - 68, T.height - 68, rounded ? 12 : 0);
      ctx.stroke();
    },
    drawFg: function (ctx, T) {
      ctx.textAlign = "center";
      ctx.fillStyle = accentColor;
      ctx.font = 'italic 500 32px "Cormorant Garamond", serif';
      const label = name && name.trim() ? name.trim() : "Bingkai Saya";
      ctx.fillText(label, T.width / 2, T.height - captionH / 2 + 12);
    },
  };
}

const FILTERS = [
  { id: "normal", name: "Original", css: "none" },
  {
    id: "vintage",
    name: "Vintage",
    css: "sepia(0.35) saturate(1.35) contrast(1.1) brightness(1.05) hue-rotate(-8deg)",
  },
  { id: "bw", name: "B&W", css: "grayscale(1) contrast(1.08)" },
  {
    id: "warm",
    name: "Warm",
    css: "saturate(1.2) hue-rotate(-10deg) brightness(1.05)",
  },
  {
    id: "cool",
    name: "Cool",
    css: "saturate(1.1) hue-rotate(15deg) brightness(1.02)",
  },
];

const RES = 2;

/* ================= dummy QR code (visual placeholder only, not scannable) ================= */
function seededRandomGrid(seed, modules) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const rnd = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 4294967295;
  };
  const grid = Array.from({ length: modules }, () =>
    Array.from({ length: modules }, () => rnd() > 0.56),
  );
  // stamp the three classic QR finder squares so it reads as a "QR code"
  const stampFinder = (ox, oy) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const onBorder = x === 0 || x === 6 || y === 0 || y === 6;
        const onCore = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        grid[oy + y][ox + x] = onBorder || onCore;
      }
    }
  };
  stampFinder(0, 0);
  stampFinder(modules - 7, 0);
  stampFinder(0, modules - 7);
  return grid;
}

function DummyQR({
  seed,
  size = 168,
  dark = COLORS.ink,
  light = COLORS.ivory,
}) {
  const modules = 21;
  const grid = useMemo(() => seededRandomGrid(seed, modules), [seed]);
  const cell = size / modules;
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      style={{ display: "block" }}
    >
      <rect x="0" y="0" width={size} height={size} fill={light} />
      {grid.map((row, y) =>
        row.map(
          (on, x) =>
            on && (
              <rect
                key={`${x}-${y}`}
                x={x * cell}
                y={y * cell}
                width={cell + 0.5}
                height={cell + 0.5}
                fill={dark}
              />
            ),
        ),
      )}
    </svg>
  );
}

export default function LumiereBooth() {
  const [step, setStep] = useState("start"); // start | payment | permission | capture | review | filter | frame | preview | done
  const [rawPhotos, setRawPhotos] = useState([]); // {img}
  const [filterId, setFilterId] = useState("normal");
  const [photos, setPhotos] = useState([]); // {url, img}
  const [templateId, setTemplateId] = useState(BUILTIN_TEMPLATES[0].id);
  const [slotStates, setSlotStates] = useState([]);
  const [armedPhotoIndex, setArmedPhotoIndex] = useState(null);
  const [activeSlotIndex, setActiveSlotIndex] = useState(null);
  const [countdownRunning, setCountdownRunning] = useState(false);
  const [countdownDisplay, setCountdownDisplay] = useState("");
  const [countdownKey, setCountdownKey] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const [cameraStatus, setCameraStatus] = useState("idle"); // idle | requesting | ready | error
  const [cameraErrorMsg, setCameraErrorMsg] = useState("");
  const [retakeIndex, setRetakeIndex] = useState(null); // index of a single photo being retaken, or null for normal capture flow
  const [previewVariant, setPreviewVariant] = useState("framed"); // "framed" | "liveview" — which version is shown/downloaded on the preview screen

  /* whether captured stills (and the live clip) are flipped to match the
     mirror/selfie-view the guest sees on screen (true, default — matches
     the previous fixed behavior) or kept true-to-life / unflipped (false —
     useful when there's text/logos in the background that need to read
     correctly) */
  const [mirrorCapture, setMirrorCapture] = useState(true);
  const mirrorCaptureRef = useRef(mirrorCapture);
  useEffect(() => {
    mirrorCaptureRef.current = mirrorCapture;
  }, [mirrorCapture]);

  /* ================= cetak fisik (print) ================= */
  const [printQty, setPrintQty] = useState(1);
  const [printImageUrl, setPrintImageUrl] = useState(null);

  /* "live view" clips: a short recorded video (not a still) spanning the
     countdown + shutter, captured alongside EACH still photo. Indexed the
     same way as rawPhotos/photos (index i's clip belongs to photo i), so
     every shot gets its own live view instead of just one for the whole
     session. */
  const [liveClipUrls, setLiveClipUrls] = useState([]);
  const [liveClipMimes, setLiveClipMimes] = useState([]);
  const [liveClipSupported, setLiveClipSupported] = useState(
    typeof window !== "undefined" && !!window.MediaRecorder,
  );
  const mediaRecorderRef = useRef(null);
  const liveClipChunksRef = useRef([]);

  /* which photo's live view is currently shown/downloaded on the preview
     screen (and, while shooting, which slot a new recording belongs to) */
  const [previewLiveIndex, setPreviewLiveIndex] = useState(0);

  /* each video clip above also gets converted into a real animated GIF —
     GIFs loop forever wherever they're opened (chat apps, galleries,
     browsers) with no play button and no "hit play" step, unlike a video
     file. Conversion happens in the background right after recording
     stops, per photo; the video is kept as an automatic fallback if it
     fails. */
  const [liveClipGifUrls, setLiveClipGifUrls] = useState([]);
  const [gifGeneratingByIndex, setGifGeneratingByIndex] = useState({});
  const gifGenTokensRef = useRef({}); // idx -> token, invalidates stale in-flight generations

  /* "bingkai + live" preview: the SAME frame/template layout as the normal
     framed photo, but every slot plays its own live clip instead of the
     still — composited into one single looping animated GIF so the frame
     graphics (background + foreground art) and every slot's live view all
     move together. */
  const [framedLiveGifUrl, setFramedLiveGifUrl] = useState(null);
  const [framedLiveGifGenerating, setFramedLiveGifGenerating] = useState(false);
  const framedLiveGifTokenRef = useRef(0); // invalidates stale in-flight generations
  const framedLiveGifSignatureRef = useRef(null); // last template/slots/clips combo it was (re)built for — avoids redundant regeneration

  /* ================= post-payment session countdown ================= */
  const [sessionSecondsLeft, setSessionSecondsLeft] = useState(
    SESSION_TIME_LIMIT_SEC,
  );
  const sessionIntervalRef = useRef(null);
  const sessionExpiredRef = useRef(false); // guard so the auto-skip only fires once per session

  /* frame templates auto-loaded from src/assets/frames/*.png (see
     FRAME_FOLDER_MODULES) — treated as built-in, not user-editable */
  const [folderTemplates, setFolderTemplates] = useState([]);

  /* user-created custom frame templates (persisted via window.storage) */
  const [customTemplates, setCustomTemplates] = useState([]); // array of specs
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderName, setBuilderName] = useState("");
  const [builderLayout, setBuilderLayout] = useState("column"); // column | row | grid
  const [builderCount, setBuilderCount] = useState(3);
  const [builderShape, setBuilderShape] = useState("rect"); // rect | circle
  const [builderRounded, setBuilderRounded] = useState(true);
  const [builderAccent, setBuilderAccent] = useState("#c6a25c");
  const [builderFrame, setBuilderFrame] = useState("#f3ead9");
  const [builderCard, setBuilderCard] = useState("#100d0b");
  const [builderMode] = useState("image"); // image only (design mode removed)
  const [builderImageFile, setBuilderImageFile] = useState(null); // {dataUrl, width, height}
  const [builderImageError, setBuilderImageError] = useState("");
  const [assetTick, setAssetTick] = useState(0); // bumped when an uploaded frame image finishes decoding

  const templates = useMemo(
    () => [
      ...BUILTIN_TEMPLATES,
      ...folderTemplates,
      ...customTemplates.map((spec) =>
        buildCustomTemplate(spec, () => setAssetTick((t) => t + 1)),
      ),
    ],
    [folderTemplates, customTemplates],
  );

  /* load every PNG dropped into src/assets/frames/ once on mount */
  useEffect(() => {
    let cancelled = false;
    const entries = Object.entries(FRAME_FOLDER_MODULES);
    if (entries.length === 0) return;
    (async () => {
      const results = await Promise.all(
        entries.map(([path, mod]) => buildFolderFrameSpec(path, mod.default)),
      );
      if (cancelled) return;
      const specs = results.filter(Boolean);
      setFolderTemplates(
        specs.map((spec) => ({
          ...buildCustomTemplate(spec),
          isCustom: false,
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const workCanvasRef = useRef(null);
  const mainCanvasRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const filterPreviewCanvasRef = useRef(null);
  const filterChipRefs = useRef({});
  const templateChipRefs = useRef({});
  const builderPreviewRef = useRef(null);
  const slotStatesRef = useRef(slotStates);
  const activeSlotIndexRef = useRef(activeSlotIndex);
  const armedPhotoIndexRef = useRef(armedPhotoIndex);
  const templateIdRef = useRef(templateId);
  const photosRef = useRef(photos);
  const templatesRef = useRef(templates);
  useEffect(() => {
    slotStatesRef.current = slotStates;
  }, [slotStates]);
  useEffect(() => {
    activeSlotIndexRef.current = activeSlotIndex;
  }, [activeSlotIndex]);
  useEffect(() => {
    armedPhotoIndexRef.current = armedPhotoIndex;
  }, [armedPhotoIndex]);
  useEffect(() => {
    templateIdRef.current = templateId;
  }, [templateId]);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);
  useEffect(() => {
    templatesRef.current = templates;
  }, [templates]);

  console.log(templates);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!window.storage) return;
        const res = await window.storage.get("lumiere-custom-templates", false);
        if (cancelled || !res || !res.value) return;
        const parsed = JSON.parse(res.value);
        if (!Array.isArray(parsed)) return;
        /* uploaded frame images are stored under their own key (they can be
           much larger than the rest of the spec), so hydrate them back in */
        const hydrated = await Promise.all(
          parsed.map(async (spec) => {
            if (spec.type !== "image") return spec;
            try {
              const imgRes = await window.storage.get(
                `lumiere-frame-img-${spec.id}`,
                false,
              );
              return imgRes && imgRes.value
                ? { ...spec, imageDataUrl: imgRes.value }
                : spec;
            } catch (e) {
              console.log(e);
              return spec;
            }
          }),
        );
        if (!cancelled) setCustomTemplates(hydrated);
      } catch (e) {
        console.log(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function persistCustomTemplates(next) {
    try {
      if (!window.storage) return;
      /* keep the (potentially large) image data URL out of the shared list
         key — it's persisted separately per-template in handleSaveCustomTemplate */
      const lightweight = next.map((s) =>
        s.type === "image"
          ? {
              id: s.id,
              name: s.name,
              type: "image",
              imgW: s.imgW,
              imgH: s.imgH,
            }
          : s,
      );
      window.storage
        .set("lumiere-custom-templates", JSON.stringify(lightweight), false)
        .catch(() => {});
    } catch (e) {
      console.log(e);
    }
  }

  function currentTemplate() {
    return templates.find((t) => t.id === templateId) || templates[0];
  }

  function getWorkCanvas() {
    if (!workCanvasRef.current)
      workCanvasRef.current = document.createElement("canvas");
    return workCanvasRef.current;
  }

  /* ================= camera ================= */
  const startCamera = useCallback(() => {
    setCameraStatus("requesting");
    setCameraErrorMsg("");
    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1080 },
          height: { ideal: 1440 },
        },
        audio: false,
      })
      .then((stream) => {
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setCameraStatus("ready");
      })
      .catch(() => {
        setCameraErrorMsg(
          "Kamera tidak dapat diakses. Mohon izinkan akses kamera di pengaturan browser Anda.",
        );
        setCameraStatus("error");
      });
  }, []);

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  useEffect(() => {
    if (step !== "capture") return;
    startCamera();
    return () => {
      stopCamera();
    };
  }, [step, startCamera]);

  /* ================= post-payment session countdown ================= */
  function clearSessionTimer() {
    if (sessionIntervalRef.current) {
      clearInterval(sessionIntervalRef.current);
      sessionIntervalRef.current = null;
    }
  }

  function startSessionTimer() {
    clearSessionTimer();
    sessionExpiredRef.current = false;
    setSessionSecondsLeft(SESSION_TIME_LIMIT_SEC);
    sessionIntervalRef.current = setInterval(() => {
      setSessionSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
  }

  /* once the guest reaches "filter" (or leaves the session entirely) the
     countdown no longer matters, so stop it — this covers both the normal
     "made it in time" path and the forced-skip path below */
  useEffect(() => {
    if (step === "filter" || step === "start" || step === "payment") {
      clearSessionTimer();
    }
  }, [step]);

  useEffect(() => {
    return () => clearSessionTimer();
  }, []);

  /* time's up while still in permission/capture/review: bail out of
     whatever retake/reshoot is in progress and jump straight to filter.
     If there's still time left, this never fires and the normal
     step-by-step flow (including retakes) runs as usual. */
  useEffect(() => {
    if (sessionSecondsLeft > 0) return;
    if (sessionExpiredRef.current) return;
    if (!["permission", "capture", "review"].includes(step)) return;
    sessionExpiredRef.current = true;
    clearSessionTimer();
    stopLiveClipRecording();
    stopCamera();
    setCountdownRunning(false);
    setCountdownDisplay("");
    setRetakeIndex(null);
    if (rawPhotos.length > 0) {
      setStep("filter");
    } else {
      // time ran out before a single shot was taken — nothing to filter,
      // so send the guest back to the start rather than to a dead screen
      fullReset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionSecondsLeft, step]);

  /* ================= reset ================= */
  function fullReset() {
    clearSessionTimer();
    setSessionSecondsLeft(SESSION_TIME_LIMIT_SEC);
    discardAllLiveClips();
    stopCamera();
    setRawPhotos([]);
    setPhotos([]);
    setFilterId("normal");
    setTemplateId(BUILTIN_TEMPLATES[0].id);
    setSlotStates([]);
    setArmedPhotoIndex(null);
    setActiveSlotIndex(null);
    setRetakeIndex(null);
    setPreviewVariant("framed");
    setPreviewLiveIndex(0);
    setMirrorCapture(true);
    setPrintQty(1);
    setPrintImageUrl(null);
    setStep("start");
  }

  /* ================= live view clip recording ================= */
  /* turn the just-recorded video clip into a real, endlessly-looping
     animated GIF by sampling frames out of it on an offscreen <video>
     and feeding them to gif.js (imported from the npm package above).
     Runs in the background; if anything here fails, the video clip is
     simply used as-is (see UI below). */
  async function generateLiveClipGif(videoBlobUrl, idx) {
    const myToken = (gifGenTokensRef.current[idx] || 0) + 1;
    gifGenTokensRef.current[idx] = myToken;
    setGifGeneratingByIndex((prev) => ({ ...prev, [idx]: true }));
    try {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.src = videoBlobUrl;
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Video tidak dapat dimuat"));
      });

      const duration =
        video.duration && isFinite(video.duration) ? video.duration : 2.5;
      const FRAME_COUNT = 14;
      const MAX_W = 480;
      const scale = Math.min(1, MAX_W / (video.videoWidth || MAX_W));
      const w = Math.round((video.videoWidth || MAX_W) * scale);
      const h = Math.round((video.videoHeight || MAX_W) * scale);

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");

      const gif = new GIF({
        workers: 2,
        quality: 10,
        width: w,
        height: h,
        workerScript: GIFJS_WORKER_URL,
      });

      const frameDelayMs = Math.max(
        60,
        Math.round((duration * 1000) / FRAME_COUNT),
      );

      for (let i = 0; i < FRAME_COUNT; i++) {
        if (gifGenTokensRef.current[idx] !== myToken) return; // superseded by a newer clip for this photo
        const t = Math.min(duration - 0.02, (i / FRAME_COUNT) * duration);
        await new Promise((resolve) => {
          const onSeeked = () => {
            video.removeEventListener("seeked", onSeeked);
            resolve();
          };
          video.addEventListener("seeked", onSeeked);
          video.currentTime = t;
        });
        // mirror the frame so it matches the selfie-view still photo,
        // following the same mirror/no-mirror choice used for the stills
        ctx.save();
        if (mirrorCaptureRef.current) {
          ctx.translate(w, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();
        gif.addFrame(ctx, { copy: true, delay: frameDelayMs });
      }

      if (gifGenTokensRef.current[idx] !== myToken) return;

      await new Promise((resolve, reject) => {
        gif.on("finished", (blob) => {
          if (gifGenTokensRef.current[idx] === myToken) {
            const url = URL.createObjectURL(blob);
            setLiveClipGifUrls((prev) => {
              const next = [...prev];
              if (next[idx]) URL.revokeObjectURL(next[idx]);
              next[idx] = url;
              return next;
            });
          }
          resolve();
        });
        gif.on("abort", () => reject(new Error("GIF dibatalkan")));
        gif.render();
      });
    } catch (e) {
      console.log(e);
      // no GIF — the recorded video clip (with loop/autoplay) is still fine
    } finally {
      if (gifGenTokensRef.current[idx] === myToken)
        setGifGeneratingByIndex((prev) => ({ ...prev, [idx]: false }));
    }
  }

  /* builds the "Bingkai + Live" GIF: the exact same template layout used by
     the normal framed photo (same background art, same slot positions/
     shapes, same foreground art, same zoom/offset per slot) — except each
     slot samples frames from that photo's own recorded live clip instead of
     the static still. Slots with no recorded clip fall back to the still so
     the frame never shows a blank hole. One combined GIF for the whole
     composition, so everything loops together in sync. */
  async function generateFramedLiveGif() {
    const myToken = framedLiveGifTokenRef.current + 1;
    framedLiveGifTokenRef.current = myToken;
    setFramedLiveGifGenerating(true);
    try {
      const T = currentTemplate();
      const allSlots = T.mirrorSlots ? [...T.slots, ...T.mirrorSlots] : T.slots;

      // one offscreen <video> per slot that has a matching live clip
      const slotVideos = await Promise.all(
        allSlots.map(async (slot, i) => {
          const ss = slotStates[i % T.slots.length];
          const clipUrl =
            ss && ss.photoIndex !== null ? liveClipUrls[ss.photoIndex] : null;
          if (!clipUrl) return null;
          const video = document.createElement("video");
          video.muted = true;
          video.playsInline = true;
          video.src = clipUrl;
          try {
            await new Promise((resolve, reject) => {
              video.onloadedmetadata = () => resolve();
              video.onerror = () =>
                reject(new Error("Video tidak dapat dimuat"));
            });
          } catch (e) {
            console.log(e);
            return null;
          }
          return video;
        }),
      );

      if (framedLiveGifTokenRef.current !== myToken) return;
      if (slotVideos.every((v) => !v)) return; // nothing to animate

      const durations = slotVideos
        .filter(Boolean)
        .map((v) => (v.duration && isFinite(v.duration) ? v.duration : 2.5));
      const duration = durations.length ? Math.max(...durations) : 2.5;
      const FRAME_COUNT = 14;
      const w = Math.round(T.width * RES);
      const h = Math.round(T.height * RES);

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");

      const gif = new GIF({
        workers: 2,
        quality: 10,
        width: w,
        height: h,
        workerScript: GIFJS_WORKER_URL,
      });

      const frameDelayMs = Math.max(
        60,
        Math.round((duration * 1000) / FRAME_COUNT),
      );

      function paintFramedLiveSlot(slot, ss, video) {
        ctx.save();
        clipSlot(ctx, slot);
        if (video) {
          const vw = video.videoWidth || slot.w;
          const vh = video.videoHeight || slot.h;
          const baseScale = Math.max(slot.w / vw, slot.h / vh);
          const zoom = ss ? ss.zoom : 1;
          const scale = baseScale * zoom;
          const dw = vw * scale,
            dh = vh * scale;
          const cx = slot.x + slot.w / 2 + (ss ? ss.offsetX : 0);
          const cy = slot.y + slot.h / 2 + (ss ? ss.offsetY : 0);
          // mirror to match the selfie-view still, same as the recorded
          // stills and the single-clip GIF above — flip in place around
          // this slot's own center so only this slot's image flips
          if (mirrorCaptureRef.current) {
            ctx.translate(cx, 0);
            ctx.scale(-1, 1);
            ctx.translate(-cx, 0);
          }
          ctx.drawImage(video, cx - dw / 2, cy - dh / 2, dw, dh);
        } else if (ss && ss.photoIndex !== null && photos[ss.photoIndex]) {
          const img = photos[ss.photoIndex].img;
          const baseScale = Math.max(slot.w / img.width, slot.h / img.height);
          const scale = baseScale * ss.zoom;
          const dw = img.width * scale,
            dh = img.height * scale;
          const cx = slot.x + slot.w / 2 + ss.offsetX;
          const cy = slot.y + slot.h / 2 + ss.offsetY;
          ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
        }
        ctx.restore();
      }

      for (let f = 0; f < FRAME_COUNT; f++) {
        if (framedLiveGifTokenRef.current !== myToken) return;
        const t = Math.min(duration - 0.02, (f / FRAME_COUNT) * duration);
        await Promise.all(
          slotVideos.map((video) => {
            if (!video) return Promise.resolve();
            const vDur =
              video.duration && isFinite(video.duration)
                ? video.duration
                : duration;
            const vt = Math.min(vDur - 0.02, t % vDur);
            return new Promise((resolve) => {
              const onSeeked = () => {
                video.removeEventListener("seeked", onSeeked);
                resolve();
              };
              video.addEventListener("seeked", onSeeked);
              video.currentTime = Math.max(0, vt);
            });
          }),
        );

        if (framedLiveGifTokenRef.current !== myToken) return;

        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.scale(RES, RES);
        T.drawBg(ctx, T);
        T.slots.forEach((slot, i) => {
          paintFramedLiveSlot(slot, slotStates[i], slotVideos[i]);
        });
        if (T.mirrorSlots) {
          T.mirrorSlots.forEach((slot, i) => {
            paintFramedLiveSlot(
              slot,
              slotStates[i],
              slotVideos[T.slots.length + i],
            );
          });
        }
        T.drawFg(ctx, T);
        ctx.restore();

        gif.addFrame(ctx, { copy: true, delay: frameDelayMs });
      }

      if (framedLiveGifTokenRef.current !== myToken) return;

      await new Promise((resolve, reject) => {
        gif.on("finished", (blob) => {
          if (framedLiveGifTokenRef.current === myToken) {
            const url = URL.createObjectURL(blob);
            setFramedLiveGifUrl((prev) => {
              if (prev) URL.revokeObjectURL(prev);
              return url;
            });
          }
          resolve();
        });
        gif.on("abort", () => reject(new Error("GIF dibatalkan")));
        gif.render();
      });
    } catch (e) {
      console.log(e);
    } finally {
      if (framedLiveGifTokenRef.current === myToken)
        setFramedLiveGifGenerating(false);
    }
  }

  /* whether the current template has at least one slot whose assigned
     photo has a recorded live clip — used to enable the "Bingkai + Live"
     tab and to decide whether it's worth (re)generating that GIF */
  function hasFramedLiveClip() {
    return slotStates.some(
      (ss) => ss && ss.photoIndex !== null && liveClipUrls[ss.photoIndex],
    );
  }

  /* fingerprint of everything the "Bingkai + Live" GIF depends on, so we
     can tell whether an already-built (or in-flight) GIF is still valid
     for the current template/slot/clip combo */
  function framedLiveSignature() {
    return JSON.stringify([
      templateId,
      slotStates.map(
        (ss) => ss && [ss.photoIndex, ss.zoom, ss.offsetX, ss.offsetY],
      ),
      liveClipUrls,
    ]);
  }

  /* (re)builds the "Bingkai + Live" GIF only if it hasn't already been
     built (or isn't already being built) for the current combo — used both
     by the pre-preview loading screen and by the tab switch, so switching
     to a tab that's already ready doesn't trigger pointless extra work */
  function maybeGenerateFramedLiveGif() {
    if (!hasFramedLiveClip()) return Promise.resolve();
    const sig = framedLiveSignature();
    if (
      sig === framedLiveGifSignatureRef.current &&
      (framedLiveGifUrl || framedLiveGifGenerating)
    ) {
      return Promise.resolve();
    }
    framedLiveGifSignatureRef.current = sig;
    return generateFramedLiveGif();
  }

  function pickRecorderMimeType() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    const candidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4",
    ];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return "";
  }

  function startLiveClipRecording(idx) {
    const stream = streamRef.current;
    if (!stream || !window.MediaRecorder) {
      setLiveClipSupported(false);
      return;
    }
    try {
      const mime = pickRecorderMimeType();
      liveClipChunksRef.current = [];
      const rec = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) liveClipChunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        if (liveClipChunksRef.current.length === 0) return;
        const type = mime || "video/webm";
        const blob = new Blob(liveClipChunksRef.current, { type });
        const url = URL.createObjectURL(blob);
        setLiveClipUrls((prev) => {
          const next = [...prev];
          if (next[idx]) URL.revokeObjectURL(next[idx]);
          next[idx] = url;
          return next;
        });
        setLiveClipMimes((prev) => {
          const next = [...prev];
          next[idx] = type;
          return next;
        });
        generateLiveClipGif(url, idx);
      };
      rec.start();
      mediaRecorderRef.current = rec;
      setLiveClipSupported(true);
    } catch (e) {
      console.log(e);
      setLiveClipSupported(false);
    }
  }

  function stopLiveClipRecording() {
    const rec = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch (e) {
        console.log(e);
      }
    }
  }

  /* clears just one photo's slot (used right before a fresh/retake
     recording starts for that index) */
  function resetLiveClipSlot(idx) {
    gifGenTokensRef.current[idx] = (gifGenTokensRef.current[idx] || 0) + 1; // invalidate in-flight GIF gen for this slot
    stopLiveClipRecording();
    setGifGeneratingByIndex((prev) => ({ ...prev, [idx]: false }));
    setLiveClipUrls((prev) => {
      if (!prev[idx]) return prev;
      const next = [...prev];
      URL.revokeObjectURL(next[idx]);
      next[idx] = null;
      return next;
    });
    setLiveClipGifUrls((prev) => {
      if (!prev[idx]) return prev;
      const next = [...prev];
      URL.revokeObjectURL(next[idx]);
      next[idx] = null;
      return next;
    });
  }

  /* clears every photo's live view (full retake / full reset) */
  function discardAllLiveClips() {
    gifGenTokensRef.current = {};
    framedLiveGifTokenRef.current += 1; // invalidate any in-flight framed-live generation
    stopLiveClipRecording();
    setGifGeneratingByIndex({});
    setLiveClipUrls((prev) => {
      prev.forEach((u) => u && URL.revokeObjectURL(u));
      return [];
    });
    setLiveClipGifUrls((prev) => {
      prev.forEach((u) => u && URL.revokeObjectURL(u));
      return [];
    });
    setLiveClipMimes([]);
    setFramedLiveGifGenerating(false);
    setFramedLiveGifUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  useEffect(() => {
    return () => {
      gifGenTokensRef.current = {};
      framedLiveGifTokenRef.current += 1;
      stopLiveClipRecording();
      setLiveClipUrls((prev) => {
        prev.forEach((u) => u && URL.revokeObjectURL(u));
        return prev;
      });
      setLiveClipGifUrls((prev) => {
        prev.forEach((u) => u && URL.revokeObjectURL(u));
        return prev;
      });
      setFramedLiveGifUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return prev;
      });
    };
  }, []);

  /* ================= capture ================= */
  function doCapture() {
    const video = videoRef.current;
    const vw = video.videoWidth,
      vh = video.videoHeight;
    if (!vw) return;
    const wc = getWorkCanvas();
    wc.width = vw;
    wc.height = vh;
    const wctx = wc.getContext("2d");
    wctx.save();
    if (mirrorCaptureRef.current) {
      wctx.translate(vw, 0);
      wctx.scale(-1, 1);
    }
    wctx.drawImage(video, 0, 0, vw, vh);
    wctx.restore();
    const url = wc.toDataURL("image/jpeg", 0.92);
    const img = new Image();
    img.onload = () => {
      if (retakeIndex !== null) {
        // retaking a single photo: replace it in place, then go straight back to review
        const idx = retakeIndex;
        setRawPhotos((prev) => {
          const next = [...prev];
          next[idx] = { img };
          return next;
        });
        setTimeout(() => {
          stopLiveClipRecording();
          stopCamera();
          setRetakeIndex(null);
          setStep("review");
        }, 500);
        return;
      }
      setRawPhotos((prev) => {
        const next = [...prev, { img }];
        if (next.length >= TOTAL_SHOTS) {
          setTimeout(() => {
            stopLiveClipRecording();
            stopCamera();
            setStep("review");
          }, 500);
        }
        return next;
      });
    };
    img.src = url;
    setFlashKey((k) => k + 1);
  }

  function handleCaptureClick() {
    if (
      countdownRunning ||
      cameraStatus !== "ready" ||
      (retakeIndex === null && rawPhotos.length >= TOTAL_SHOTS)
    )
      return;
    const shotIndex = retakeIndex !== null ? retakeIndex : rawPhotos.length;
    resetLiveClipSlot(shotIndex);
    startLiveClipRecording(shotIndex);
    setCountdownRunning(true);
    let n = 3;
    const tick = () => {
      setCountdownDisplay(n > 0 ? String(n) : "");
      setCountdownKey((k) => k + 1);
      if (n === 0) {
        doCapture();
        setCountdownRunning(false);
        return;
      }
      n--;
      setTimeout(tick, 800);
    };
    tick();
  }

  /* ================= review (Hasil Foto) screen ================= */
  function handleRetakeAll() {
    setRetakeIndex(null);
    setRawPhotos([]);
    discardAllLiveClips();
    setStep("capture");
  }

  function handleRetakeOne(i) {
    setRetakeIndex(i);
    setStep("capture");
  }

  function handleUsePhotos() {
    setStep("filter");
  }

  /* ================= filter screen ================= */
  useEffect(() => {
    if (step !== "filter" || !rawPhotos[0]) return;
    const sample = rawPhotos[0].img;
    FILTERS.forEach((f) => {
      const c = filterChipRefs.current[f.id];
      if (c) drawFilteredInto(c.getContext("2d"), sample, f.css, 140, 140);
    });
  }, [step, rawPhotos]);

  useEffect(() => {
    if (step !== "filter" || !rawPhotos[0]) return;
    const sample = rawPhotos[0].img;
    const canvas = filterPreviewCanvasRef.current;
    if (!canvas) return;
    const w = 520;
    let h = Math.round(w * (sample.height / sample.width));
    h = Math.min(h, 620);
    canvas.width = w;
    canvas.height = h;
    const css = (FILTERS.find((f) => f.id === filterId) || FILTERS[0]).css;
    drawFilteredInto(canvas.getContext("2d"), sample, css, w, h);
  }, [step, rawPhotos, filterId]);

  function bakeFilterAndProceed() {
    const css = (FILTERS.find((f) => f.id === filterId) || FILTERS[0]).css;
    const wc = getWorkCanvas();
    const wctx = wc.getContext("2d");
    const promises = rawPhotos.map(
      (rp) =>
        new Promise((resolve) => {
          const w = rp.img.width,
            h = rp.img.height;
          wc.width = w;
          wc.height = h;
          wctx.save();
          wctx.clearRect(0, 0, w, h);
          try {
            wctx.filter = css;
          } catch (e) {
            console.log(e);
          }
          wctx.drawImage(rp.img, 0, 0, w, h);
          wctx.restore();
          const url = wc.toDataURL("image/jpeg", 0.92);
          const img = new Image();
          img.onload = () => resolve({ url, img });
          img.src = url;
        }),
    );
    Promise.all(promises).then((results) => {
      setPhotos(results);
      setSlotStates(rebuildSlotStatesFor(templates, templateId, results));
      setActiveSlotIndex(null);
      setStep("frame");
    });
  }

  /* ================= frame / editor ================= */
  useEffect(() => {
    if (step !== "frame") return;
    templates.forEach((T) => {
      const c = templateChipRefs.current[T.id];
      if (c) renderTemplateChipPreview(c, T);
    });
  }, [step, templates, assetTick]);

  function drawComposition(canvas, forExport) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const T = currentTemplate();
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(RES, RES);
    T.drawBg(ctx, T);

    function paintSlot(slot, ss) {
      ctx.save();
      clipSlot(ctx, slot);
      if (ss && ss.photoIndex !== null && photos[ss.photoIndex]) {
        const img = photos[ss.photoIndex].img;
        const baseScale = Math.max(slot.w / img.width, slot.h / img.height);
        const scale = baseScale * ss.zoom;
        const dw = img.width * scale,
          dh = img.height * scale;
        const cx = slot.x + slot.w / 2 + ss.offsetX;
        const cy = slot.y + slot.h / 2 + ss.offsetY;
        ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
      } else {
        ctx.fillStyle = "rgba(198,162,92,0.10)";
        ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
        ctx.strokeStyle = "rgba(198,162,92,0.5)";
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 8]);
        ctx.strokeRect(slot.x + 4, slot.y + 4, slot.w - 8, slot.h - 8);
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(198,162,92,0.8)";
        ctx.font = Math.min(slot.w, slot.h) * 0.12 + 'px "Jost", sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("+", slot.x + slot.w / 2, slot.y + slot.h / 2);
        ctx.textBaseline = "alphabetic";
      }
      ctx.restore();
      strokeSlot(ctx, slot, "rgba(198,162,92,0.85)", 2);
    }

    for (let i = 0; i < T.slots.length; i++) {
      paintSlot(T.slots[i], slotStates[i]);
      if (!forExport && activeSlotIndex === i) {
        ctx.save();
        strokeSlot(ctx, T.slots[i], "#e2c78a", 5);
        ctx.restore();
      }
    }

    if (T.mirrorSlots) {
      for (let i = 0; i < T.mirrorSlots.length; i++) {
        paintSlot(T.mirrorSlots[i], slotStates[i]);
      }
    }
    T.drawFg(ctx, T);
    ctx.restore();
  }

  function drawMain(forExport) {
    drawComposition(mainCanvasRef.current, forExport);
  }

  function drawPreview() {
    drawComposition(previewCanvasRef.current, true);
  }

  /* resize canvas when entering frame / switching template */
  useEffect(() => {
    if (step !== "frame") return;
    const canvas = mainCanvasRef.current;
    if (!canvas) return;
    const T = currentTemplate();
    canvas.width = T.width * RES;
    canvas.height = T.height * RES;
    canvas.style.aspectRatio = `${T.width} / ${T.height}`;
    drawMain(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, templateId]);

  /* redraw once an uploaded frame image finishes decoding */
  useEffect(() => {
    if (step === "frame") drawMain(false);
    if (step === "preview") drawPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetTick]);

  /* default the live-view selector to the first photo that actually has a
     recorded clip whenever the guest lands on the preview screen */
  useEffect(() => {
    if (step !== "preview") return;
    const firstWithClip = liveClipUrls.findIndex((u) => !!u);
    setPreviewLiveIndex(firstWithClip >= 0 ? firstWithClip : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /* size + render the read-only final preview canvas */
  useEffect(() => {
    if (step !== "preview") return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const T = currentTemplate();
    canvas.width = T.width * RES;
    canvas.height = T.height * RES;
    canvas.style.aspectRatio = `${T.width} / ${T.height}`;
    drawPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, templateId, photos, slotStates]);

  /* (re)generate the combined "Bingkai + Live" GIF whenever the guest is
     looking at that tab and the underlying frame/slots/clips it depends on
     change — same trigger pattern as the per-photo GIF above, just for the
     whole composited frame instead of a single slot. Skips work entirely
     if it's already built (or building) for the current combo, e.g. right
     after the pre-preview loading screen below already built it. */
  useEffect(() => {
    if (step !== "preview" || previewVariant !== "framed-live") return;
    maybeGenerateFramedLiveGif();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, previewVariant, templateId, slotStates, liveClipUrls]);

  /* transitional loading screen shown right after "Lanjut ke Preview":
     builds the "Bingkai + Live" GIF up front (so it's instantly ready the
     moment the guest taps that tab) before actually revealing the final
     preview screen. Skipped entirely if there's nothing to build. */
  useEffect(() => {
    if (step !== "preparingPreview") return;
    let cancelled = false;
    maybeGenerateFramedLiveGif().finally(() => {
      if (!cancelled) setStep("preview");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /* redraw when slot states / active slot / photos change */
  useEffect(() => {
    if (step !== "frame") return;
    drawMain(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotStates, activeSlotIndex, photos]);

  /* pointer / wheel / touch interaction on the main canvas */
  useEffect(() => {
    if (step !== "frame") return;
    const canvas = mainCanvasRef.current;
    if (!canvas) return;

    function currentT() {
      return (
        templatesRef.current.find((t) => t.id === templateIdRef.current) ||
        templatesRef.current[0]
      );
    }
    function getPointerPos(e) {
      const rect = canvas.getBoundingClientRect();
      const T = currentT();
      const clientX =
        e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
      const clientY =
        e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY;
      return {
        x: (clientX - rect.left) * (T.width / rect.width),
        y: (clientY - rect.top) * (T.height / rect.height),
      };
    }
    function findSlotAt(pos) {
      const T = currentT();
      for (let i = 0; i < T.slots.length; i++)
        if (pointInSlot(pos.x, pos.y, T.slots[i])) return i;
      return -1;
    }

    let dragging = false,
      dragStart = null,
      dragOrig = null;

    function onPointerDown(e) {
      const pos = getPointerPos(e);
      const idx = findSlotAt(pos);
      if (idx < 0) return;
      if (armedPhotoIndexRef.current !== null) {
        const next = slotStatesRef.current.map((s, i) =>
          i === idx
            ? {
                photoIndex: armedPhotoIndexRef.current,
                zoom: 1,
                offsetX: 0,
                offsetY: 0,
              }
            : s,
        );
        slotStatesRef.current = next;
        setSlotStates(next);
        setArmedPhotoIndex(null);
        setActiveSlotIndex(idx);
        return;
      }
      const ss = slotStatesRef.current[idx];
      if (ss && ss.photoIndex !== null) {
        setActiveSlotIndex(idx);
        dragging = true;
        dragStart = pos;
        dragOrig = { x: ss.offsetX, y: ss.offsetY };
        canvas.style.cursor = "grabbing";
        canvas.setPointerCapture(e.pointerId);
      } else {
        setActiveSlotIndex(idx);
      }
    }
    function onPointerMove(e) {
      if (!dragging) return;
      const pos = getPointerPos(e);
      const T = currentT();
      const idx = activeSlotIndexRef.current;
      const slot = T.slots[idx];
      const ss = { ...slotStatesRef.current[idx] };
      const dx = pos.x - dragStart.x,
        dy = pos.y - dragStart.y;
      ss.offsetX = dragOrig.x + dx;
      ss.offsetY = dragOrig.y + dy;
      clampSlotState(
        slot,
        ss,
        photosRef.current[ss.photoIndex] &&
          photosRef.current[ss.photoIndex].img,
      );
      const next = slotStatesRef.current.map((s, i) => (i === idx ? ss : s));
      slotStatesRef.current = next;
      setSlotStates(next);
    }
    function endDrag() {
      dragging = false;
      canvas.style.cursor = "grab";
    }
    function onWheel(e) {
      const pos = getPointerPos(e);
      const idx = findSlotAt(pos);
      if (idx < 0) return;
      const ss0 = slotStatesRef.current[idx];
      if (!ss0 || ss0.photoIndex === null) return;
      e.preventDefault();
      const T = currentT();
      const slot = T.slots[idx];
      const ss = { ...ss0 };
      ss.zoom = Math.min(3, Math.max(1, ss.zoom - e.deltaY * 0.0012));
      clampSlotState(slot, ss, photosRef.current[ss.photoIndex].img);
      const next = slotStatesRef.current.map((s, i) => (i === idx ? ss : s));
      slotStatesRef.current = next;
      setSlotStates(next);
      setActiveSlotIndex(idx);
    }

    let pinch = null;
    function onTouchStart(e) {
      if (e.touches.length === 2) {
        const pos1 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        const pos2 = { x: e.touches[1].clientX, y: e.touches[1].clientY };
        const dist = Math.hypot(pos2.x - pos1.x, pos2.y - pos1.y);
        const idx = activeSlotIndexRef.current;
        if (idx === null || idx === undefined) return;
        const ss = slotStatesRef.current[idx];
        if (!ss || ss.photoIndex === null) return;
        pinch = { dist, startZoom: ss.zoom, idx };
        dragging = false;
      }
    }
    function onTouchMove(e) {
      if (pinch && e.touches.length === 2) {
        const pos1 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        const pos2 = { x: e.touches[1].clientX, y: e.touches[1].clientY };
        const dist = Math.hypot(pos2.x - pos1.x, pos2.y - pos1.y);
        const T = currentT();
        const slot = T.slots[pinch.idx];
        const ss = { ...slotStatesRef.current[pinch.idx] };
        ss.zoom = Math.min(
          3,
          Math.max(1, pinch.startZoom * (dist / pinch.dist)),
        );
        clampSlotState(slot, ss, photosRef.current[ss.photoIndex].img);
        const next = slotStatesRef.current.map((s, i) =>
          i === pinch.idx ? ss : s,
        );
        slotStatesRef.current = next;
        setSlotStates(next);
      }
    }
    function onTouchEnd(e) {
      if (e.touches.length < 2) pinch = null;
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove", onTouchMove, { passive: true });
    canvas.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
    };
  }, [step]);

  /* active slot panel */
  function handleZoomChange(e) {
    if (activeSlotIndex === null) return;
    const T = currentTemplate();
    const slot = T.slots[activeSlotIndex];
    const ss = { ...slotStates[activeSlotIndex] };
    ss.zoom = parseFloat(e.target.value);
    clampSlotState(
      slot,
      ss,
      photos[ss.photoIndex] && photos[ss.photoIndex].img,
    );
    const next = slotStates.map((s, i) => (i === activeSlotIndex ? ss : s));
    setSlotStates(next);
  }

  function handleResetPos() {
    if (activeSlotIndex === null) return;
    const next = slotStates.map((s, i) =>
      i === activeSlotIndex ? { ...s, zoom: 1, offsetX: 0, offsetY: 0 } : s,
    );
    setSlotStates(next);
  }

  function handleClearSlot() {
    if (activeSlotIndex === null) return;
    const next = slotStates.map((s, i) =>
      i === activeSlotIndex
        ? { photoIndex: null, zoom: 1, offsetX: 0, offsetY: 0 }
        : s,
    );
    setSlotStates(next);
  }

  function handleTemplateClick(T) {
    setTemplateId(T.id);
    setSlotStates(rebuildSlotStatesFor(templates, T.id, photos));
    setActiveSlotIndex(null);
  }

  function handleGalleryClick(idx) {
    setArmedPhotoIndex((prev) => (prev === idx ? null : idx));
  }

  /* renders the final composited (framed) photo to an offscreen canvas —
     shared by the PNG download and the print flow so they stay in sync */
  function renderFinalOffscreenCanvas() {
    const T = currentTemplate();
    const off = document.createElement("canvas");
    off.width = T.width * RES;
    off.height = T.height * RES;
    drawComposition(off, true);
    return off;
  }

  function handleDownload() {
    const T = currentTemplate();
    const off = renderFinalOffscreenCanvas();
    const link = document.createElement("a");
    link.download = `Astâr-booth-${T.id}.png`;
    link.href = off.toDataURL("image/png");
    link.click();
  }

  /* "normal photos" export: every single shot exactly as filtered/mirrored
     when it was taken — no frame, no live view, just the plain still —
     one file per shot. Staggered like the live-view "download all" so the
     browser doesn't treat the burst of downloads as a popup flood. */
  function handleDownloadAllPhotos() {
    let delay = 0;
    photos.forEach((p, i) => {
      if (!p || !p.url) return;
      const runDelay = delay;
      setTimeout(() => {
        const link = document.createElement("a");
        link.download = `Astâr-booth-foto-${i + 1}.jpg`;
        link.href = p.url;
        link.click();
      }, runDelay);
      delay += 400;
    });
  }

  /* "live view" export: the filtered photo(s) exactly as captured by the
     camera, with no frame/template composited on top */
  /* "live view" export: the short recorded clip spanning the countdown +
     shutter — an actual moving video, not a still frame */
  /* "live view" export: prefer the real animated GIF (loops forever
     anywhere it's opened — chat apps, galleries, browsers — with no play
     button needed); fall back to the recorded video clip if the GIF
     hasn't finished generating or failed to generate. Downloads EVERY
     photo's live view (not just the one currently shown on screen), one
     file per shot, staggered slightly so the browser doesn't treat the
     burst of downloads as a popup flood and block them. */
  function handleDownloadLiveView() {
    const total = Math.max(liveClipUrls.length, liveClipGifUrls.length);
    let delay = 0;
    for (let i = 0; i < total; i++) {
      const gifUrl = liveClipGifUrls[i];
      const clipUrl = liveClipUrls[i];
      if (!gifUrl && !clipUrl) continue;
      const runDelay = delay;
      setTimeout(() => {
        const link = document.createElement("a");
        if (gifUrl) {
          link.download = `Astâr-booth-liveview-${i + 1}.gif`;
          link.href = gifUrl;
        } else {
          const mime = liveClipMimes[i] || "video/webm";
          const ext = mime.includes("mp4") ? "mp4" : "webm";
          link.download = `Astâr-booth-liveview-${i + 1}.${ext}`;
          link.href = clipUrl;
        }
        link.click();
      }, runDelay);
      delay += 400;
    }
  }

  /* how many shots actually have a usable live-view clip (video and/or
     GIF) — used to label/enable the "download all" button */
  function liveClipsAvailableCount() {
    const total = Math.max(liveClipUrls.length, liveClipGifUrls.length);
    let n = 0;
    for (let i = 0; i < total; i++) {
      if (liveClipUrls[i] || liveClipGifUrls[i]) n++;
    }
    return n;
  }

  /* downloads the combined "Bingkai + Live" GIF; if it hasn't finished
     generating yet, falls back to the static framed PNG so "Simpan" always
     produces something rather than doing nothing */
  function handleDownloadFramedLive() {
    if (framedLiveGifUrl) {
      const T = currentTemplate();
      const link = document.createElement("a");
      link.download = `Astâr-booth-bingkai-live-${T.id}.gif`;
      link.href = framedLiveGifUrl;
      link.click();
    } else {
      handleDownload();
    }
  }

  /* "Simpan" only moves the guest to the SELESAI screen — it no longer
     downloads anything by itself. Every download (framed, framed+live,
     all photos, all live views) only happens when the guest explicitly
     taps one of the download buttons on that screen. */
  function handleSaveAndFinish() {
    setStep("done");
  }

  /* ================= cetak fisik (print) ================= */
  /* re-renders the framed photo as an image so it can be previewed and
     repeated in the hidden print area, then opens the quantity screen */
  function openPrintFlow() {
    const off = renderFinalOffscreenCanvas();
    setPrintImageUrl(off.toDataURL("image/png"));
    setPrintQty(1);
    setStep("printQty");
  }

  /* actually sends the job to the printer via the browser's print dialog.
     The hidden #lb-print-area below is repeated once per copy requested,
     so the OS print dialog produces exactly `printQty` pages/prints in a
     single job. */
  function handlePrint() {
    window.print();
    setStep("printDone");
  }

  /* ================= custom frame builder ================= */
  function resetBuilderForm() {
    setBuilderName("");
    setBuilderLayout("column");
    setBuilderCount(3);
    setBuilderShape("rect");
    setBuilderRounded(true);
    setBuilderAccent("#c6a25c");
    setBuilderFrame("#f3ead9");
    setBuilderCard("#100d0b");
    setBuilderImageFile(null);
    setBuilderImageError("");
  }

  // eslint-disable-next-line no-unused-vars
  function openBuilder() {
    resetBuilderForm();
    setBuilderOpen(true);
  }

  function closeBuilder() {
    setBuilderOpen(false);
  }

  function currentBuilderSpec(idOverride) {
    if (builderMode === "image") {
      return {
        id: idOverride || "preview",
        name: builderName,
        type: "image",
        imageDataUrl: builderImageFile ? builderImageFile.dataUrl : null,
        imgW: builderImageFile ? builderImageFile.width : 1000,
        imgH: builderImageFile ? builderImageFile.height : 1000,
        hasHole: builderImageFile ? builderImageFile.hasHole : false,
        holeX: builderImageFile ? builderImageFile.holeX : 0,
        holeY: builderImageFile ? builderImageFile.holeY : 0,
        holeW: builderImageFile ? builderImageFile.holeW : 1000,
        holeH: builderImageFile ? builderImageFile.holeH : 1000,
        holes: builderImageFile ? builderImageFile.holes : [],
        count: builderCount,
      };
    }
    return {
      id: idOverride || "preview",
      name: builderName,
      layout: builderLayout,
      count: builderCount,
      shape: builderShape,
      rounded: builderRounded,
      accentColor: builderAccent,
      frameColor: builderFrame,
      cardColor: builderCard,
    };
  }

  function handleBuilderImageSelect(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type || !file.type.startsWith("image/")) {
      setBuilderImageError(
        "File harus berupa gambar (PNG transparan disarankan).",
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const rawUrl = reader.result;
      const probe = new Image();
      probe.onload = () => {
        let width = probe.width,
          height = probe.height;
        let finalUrl = rawUrl;
        if (Math.max(width, height) > MAX_FRAME_IMG_DIM) {
          const scale = MAX_FRAME_IMG_DIM / Math.max(width, height);
          const w = Math.round(width * scale),
            h = Math.round(height * scale);
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          c.getContext("2d").drawImage(probe, 0, 0, w, h);
          finalUrl = c.toDataURL("image/png");
          width = w;
          height = h;
        }
        const cached = new Image();
        cached.onload = () => {
          frameImageCache.set(finalUrl, cached);
          const regions = detectTransparentRegions(cached, width, height);
          const hasHole = regions.length > 0;
          let holeX = 0,
            holeY = 0,
            holeW = width,
            holeH = height;
          if (hasHole) {
            holeX = Math.min(...regions.map((r) => r.x));
            holeY = Math.min(...regions.map((r) => r.y));
            holeW = Math.max(...regions.map((r) => r.x + r.w)) - holeX;
            holeH = Math.max(...regions.map((r) => r.y + r.h)) - holeY;
          }
          setBuilderImageError(
            hasHole
              ? ""
              : "Tidak ada area transparan terdeteksi — foto akan mengisi seluruh gambar.",
          );
          setBuilderImageFile({
            dataUrl: finalUrl,
            width,
            height,
            hasHole,
            holeX,
            holeY,
            holeW,
            holeH,
            holes: regions,
          });
          // pre-fill "jumlah foto" to match what was actually detected, so
          // it lines up with this template by default — user can override
          setBuilderCount(
            hasHole ? Math.max(1, Math.min(6, regions.length)) : 1,
          );
        };
        cached.src = finalUrl;
      };
      probe.onerror = () =>
        setBuilderImageError("Gagal membaca gambar. Coba file lain.");
      probe.src = rawUrl;
    };
    reader.onerror = () => setBuilderImageError("Gagal membaca file.");
    reader.readAsDataURL(file);
  }

  function handleSaveCustomTemplate() {
    if (builderMode === "image" && !builderImageFile) {
      setBuilderImageError("Unggah gambar bingkai terlebih dahulu.");
      return;
    }
    const spec = currentBuilderSpec(`custom-${Date.now()}`);
    if (!spec.name.trim()) spec.name = "Bingkai Saya";
    const next = [...customTemplates, spec];
    setCustomTemplates(next);
    persistCustomTemplates(next);
    if (spec.type === "image" && window.storage) {
      window.storage
        .set(`lumiere-frame-img-${spec.id}`, spec.imageDataUrl, false)
        .catch(() => {});
    }
    setBuilderOpen(false);
    setTemplateId(spec.id);
    setSlotStates(
      rebuildSlotStatesFor(
        [...BUILTIN_TEMPLATES, ...next.map((s) => buildCustomTemplate(s))],
        spec.id,
        photos,
      ),
    );
    setActiveSlotIndex(null);
  }

  function handleDeleteCustomTemplate(e, id) {
    e.stopPropagation();
    if (!window.confirm("Hapus bingkai ini?")) return;
    const target = customTemplates.find((s) => s.id === id);
    const next = customTemplates.filter((s) => s.id !== id);
    setCustomTemplates(next);
    persistCustomTemplates(next);
    if (target && target.type === "image" && window.storage) {
      window.storage.delete(`lumiere-frame-img-${id}`, false).catch(() => {});
    }
    if (templateId === id) {
      setTemplateId(BUILTIN_TEMPLATES[0].id);
      setSlotStates(
        rebuildSlotStatesFor(
          [...BUILTIN_TEMPLATES, ...next.map((s) => buildCustomTemplate(s))],
          BUILTIN_TEMPLATES[0].id,
          photos,
        ),
      );
      setActiveSlotIndex(null);
    }
  }

  /* live preview canvas inside the builder panel */
  useEffect(() => {
    if (!builderOpen) return;
    const c = builderPreviewRef.current;
    if (!c) return;
    if (builderMode === "image" && !builderImageFile) {
      const ctx = c.getContext("2d");
      c.width = 200;
      c.height = 140;
      ctx.clearRect(0, 0, c.width, c.height);
      return;
    }
    const T = buildCustomTemplate(currentBuilderSpec());
    renderTemplateChipPreview(c, T);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    builderOpen,
    builderMode,
    builderImageFile,
    builderName,
    builderLayout,
    builderCount,
    builderShape,
    builderRounded,
    builderAccent,
    builderFrame,
    builderCard,
  ]);

  /* ================= derived UI bits ================= */
  const stepOrder = [
    "payment",
    "permission",
    "capture",
    "review",
    "filter",
    "frame",
    "preview",
  ];
  const stepIdx = stepOrder.indexOf(step);
  const activeSlotState =
    activeSlotIndex !== null ? slotStates[activeSlotIndex] : null;
  const camMsgText =
    cameraStatus === "error" ? cameraErrorMsg : "Meminta akses kamera…";
  const showCamOverlay = cameraStatus !== "ready";
  const sessionTimerActive = ["permission", "capture", "review"].includes(step);
  const sessionTimerLow = sessionSecondsLeft <= 10;
  const sessionTimerLabel = `${Math.floor(sessionSecondsLeft / 60)
    .toString()
    .padStart(
      1,
      "0",
    )}:${(sessionSecondsLeft % 60).toString().padStart(2, "0")}`;

  /* ================= shared styles ================= */
  const btnBase = {
    fontFamily: SANS,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    borderRadius: "12px",
  };

  const btnSolid = {
    ...btnBase,
    background: COLORS.gold,
    color: COLORS.ink,
    border: `1px solid ${COLORS.gold}`,
  };

  const btnGhost = {
    ...btnBase,
    background: "transparent",
    color: COLORS.ivoryDim,
    border: `1px solid ${COLORS.panelLine}`,
  };

  return (
    <div
      className="min-h-dvh w-full flex items-start justify-center md:items-center md:py-6"
      style={{ background: COLORS.bg, fontFamily: SANS, fontWeight: 300 }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,500&family=Jost:wght@300;400;500;600&display=swap');
        .lb-scrollbar-none::-webkit-scrollbar{display:none;}
        .lb-scrollbar-none{scrollbar-width:none;}
        @keyframes lbApertureOpen{from{transform:scale(.15) rotate(-50deg);opacity:0;}to{transform:scale(1) rotate(0deg);opacity:1;}}
        @keyframes lbSpin{to{transform:rotate(360deg);}}
        @keyframes lbMarkFade{from{opacity:0;transform:scale(.9);}to{opacity:1;transform:scale(1);}}
        .lb-mark-fade{animation:lbMarkFade .7s cubic-bezier(.2,.8,.2,1) both;}
        @keyframes lbFlashPop{0%{opacity:.9;}100%{opacity:0;}}
        @keyframes lbCdPop{0%{opacity:0;transform:scale(1.4);}25%{opacity:1;transform:scale(1);}80%{opacity:1;}100%{opacity:0;}}
        .lb-aperture-group{animation:lbApertureOpen 1.1s cubic-bezier(.2,.8,.2,1) both;transform-origin:100px 100px;}
        .lb-ring-spin{animation:lbSpin 40s linear infinite;transform-origin:100px 100px;}
        .lb-flash-pop{animation:lbFlashPop .35s ease;}
        .lb-cd-pop{animation:lbCdPop .9s ease;}
        input[type="range"].lb-range{accent-color:${COLORS.gold};}
        #lb-print-area{display:none;}
        @media print{
          body *{visibility:hidden;}
          #lb-print-area, #lb-print-area *{visibility:visible;}
          #lb-print-area{display:block;position:absolute;top:0;left:0;width:100%;margin:0;padding:0;}
          .lb-print-page{width:100%;display:flex;align-items:center;justify-content:center;page-break-after:always;break-after:page;}
          .lb-print-page:last-child{page-break-after:auto;break-after:auto;}
          .lb-print-page img{max-width:100%;max-height:100vh;display:block;}
        }
      `}</style>

      <div
        className="w-full max-w-220 min-h-dvh lg:min-h-200 flex flex-col relative md:rounded-2xl md:overflow-hidden"
        style={{ background: COLORS.bg, boxShadow: "0 0 60px rgba(0,0,0,.12)" }}
      >
        {/* ============ TOPBAR ============ */}
        <div
          className="flex items-center justify-between px-4.5 py-4 shrink-0"
          style={{ borderBottom: `1px solid ${COLORS.panelLine}` }}
        >
          <div className="flex items-center gap-2.5">
            <svg viewBox="0 0 40 40" fill="none" className="w-6 h-6">
              <circle
                cx="20"
                cy="20"
                r="18"
                stroke={COLORS.gold}
                strokeWidth="1.2"
              />
              <circle cx="20" cy="20" r="6" fill={COLORS.gold} />
            </svg>
            <span
              style={{
                fontFamily: SERIF,
                fontSize: 19,
                letterSpacing: "0.03em",
                color: COLORS.ivory,
              }}
            >
              Astár Booth
            </span>
          </div>

          <div className="flex items-center gap-3">
            {sessionTimerActive && (
              <div
                className="flex items-center gap-1.5 px-2.5 py-1"
                style={{
                  borderRadius: 999,
                  border: `1px solid ${sessionTimerLow ? "#c94f4f" : COLORS.panelLine}`,
                  color: sessionTimerLow ? "#c94f4f" : COLORS.muted,
                }}
                aria-label="Sisa waktu sesi"
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: sessionTimerLow ? "#c94f4f" : COLORS.gold,
                  }}
                />
                <span
                  style={{
                    fontFamily: SANS,
                    fontSize: 12,
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "0.03em",
                  }}
                >
                  {sessionTimerLabel}
                </span>
              </div>
            )}
            {stepIdx >= 0 && (
              <div className="flex items-center gap-1.5">
                {stepOrder.map((s, i) => (
                  <div
                    key={s}
                    style={{
                      width: i === stepIdx ? 18 : 6,
                      height: 6,
                      borderRadius: 3,
                      background:
                        stepIdx >= 0 && i <= stepIdx
                          ? COLORS.gold
                          : COLORS.panelLine,
                      transition: "all 200ms ease",
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ============ SCREEN 1: START ============ */}
        {step === "start" && (
          <div
            className="w-full h-full min-h-0 flex flex-col flex-1 items-center justify-center px-6 py-10"
            style={{ background: COLORS.bg }}
          >
            <div className="w-full max-w-105">
              <div className="flex flex-col items-center">
                <Sparkles size={26} color={COLORS.gold} className="mb-4" />
                <StepEyebrow>Astár Booth · Pangkalpinang</StepEyebrow>
                <StepTitle>Photobooth Kenangan</StepTitle>
                <p
                  className="text-center mb-10"
                  style={{
                    fontFamily: SANS,
                    fontSize: 13.5,
                    lineHeight: 1.7,
                    color: COLORS.ivoryDim,
                  }}
                >
                  Ambil 6 foto, pilih filter & bingkai favoritmu, lalu bawa
                  pulang hasilnya lewat QR code.
                </p>
                <PrimaryButton
                  onClick={() => setStep("payment")}
                  icon={ArrowRight}
                >
                  Mulai Sekarang
                </PrimaryButton>
              </div>
            </div>
          </div>
        )}

        {/* ============ SCREEN: PAYMENT (QRIS dummy) ============ */}
        {step === "payment" && (
          <section className="flex flex-col flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Langkah 1 dari {stepOrder.length}</StepEyebrow>
            <StepTitle>Scan QRIS untuk Membayar</StepTitle>
            <p
              className="w-full text-center mx-auto mt-2.5"
              style={{
                fontSize: 13.5,
                lineHeight: 1.65,
                color: COLORS.muted,
              }}
            >
              Buka aplikasi e-wallet atau m-banking Anda, lalu pindai kode di
              bawah ini untuk melanjutkan sesi foto.
            </p>

            <div
              className="flex flex-col items-center mt-6 mx-auto w-full"
              style={{
                maxWidth: 300,
                background: COLORS.ivory,
                border: `1px solid ${COLORS.panelLine}`,
                padding: "22px 18px",
              }}
            >
              <div
                className="flex items-center justify-between w-full mb-4"
                style={{ fontFamily: SANS }}
              >
                <span
                  style={{
                    fontFamily: SERIF,
                    fontStyle: "italic",
                    fontSize: 17,
                    color: COLORS.ink,
                  }}
                >
                  Astár Booth
                </span>
                <span
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.14em",
                    color: "#8a8a8a",
                    fontWeight: 600,
                  }}
                >
                  QRIS
                </span>
              </div>
              <DummyQR seed="astar-booth-qris" size={188} />
              <div
                className="mt-4 text-center"
                style={{
                  fontSize: 11,
                  color: "#8a8a8a",
                  letterSpacing: "0.04em",
                }}
              >
                NMID · ID10256987654 · Astár Booth
              </div>
            </div>

            <div
              className="flex flex-col items-center justify-between mt-5 mx-auto w-full"
              style={{ maxWidth: 300 }}
            >
              <span
                style={{
                  fontSize: 11.5,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: COLORS.muted,
                }}
              >
                Total Bayar
              </span>
              <span
                style={{
                  fontFamily: SERIF,
                  fontSize: 20,
                  color: COLORS.goldSoft,
                }}
              >
                Rp 25.000
              </span>
            </div>

            <div className="flex flex-col items-center justify-between mt-3">
              <p
                className="text-center"
                style={{ fontSize: 11, color: COLORS.muted, maxWidth: "34ch" }}
              >
                *Simulasi pembayaran (dummy). Tidak ada transaksi nyata yang
                diproses.
              </p>
            </div>

            <div className="mt-auto pt-5.5">
              <button
                onClick={() => {
                  startSessionTimer();
                  setStep("permission");
                }}
                className="w-full flex items-center justify-center gap-2 py-3 px-5.5 text-[13px] active:opacity-90"
                style={btnSolid}
              >
                Lanjutkan
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        )}

        {/* ============ SCREEN: CAMERA PERMISSION ============ */}
        {step === "permission" && (
          <section className="flex flex-col flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Langkah 2 dari {stepOrder.length}</StepEyebrow>
            <StepTitle>Izin Kamera</StepTitle>

            <div
              className="flex flex-col items-center gap-4 mt-6 py-10 px-6"
              style={{
                background: COLORS.panel,
                border: `1px solid ${COLORS.panelLine}`,
              }}
            >
              <Camera size={40} color={COLORS.gold} />
              <p
                className="text-center"
                style={{
                  fontSize: 13,
                  lineHeight: 1.7,
                  color: COLORS.ivoryDim,
                }}
              >
                Astár Booth membutuhkan akses kamera perangkat Anda untuk
                mengambil foto. Foto hanya disimpan di perangkat Anda selama
                sesi berlangsung.
              </p>
              {cameraStatus === "error" && cameraErrorMsg && (
                <div
                  className="flex items-start gap-2 w-full px-3 py-2.5"
                  style={{
                    background: "rgba(198,92,92,0.1)",
                    border: "1px solid rgba(198,92,92,0.35)",
                  }}
                >
                  <AlertCircle
                    size={15}
                    color="#c94f4f"
                    style={{ flexShrink: 0, marginTop: 1 }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      color: "#c94f4f",
                      lineHeight: 1.5,
                    }}
                  >
                    {cameraErrorMsg}
                  </span>
                </div>
              )}
            </div>

            <div className="mt-auto pt-5.5">
              <button
                onClick={() => setStep("capture")}
                className="w-full flex items-center justify-center gap-2 py-3 px-5.5 text-[13px] active:opacity-90"
                style={btnSolid}
              >
                Izinkan Akses Kamera
                <Camera size={16} />
              </button>
            </div>
          </section>
        )}

        {/* ============ SCREEN 2: CAPTURE ============ */}
        {step === "capture" && (
          <section className="flex flex-col  flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Langkah 3 dari {stepOrder.length}</StepEyebrow>
            <StepTitle>
              {retakeIndex !== null
                ? `Ambil Ulang Foto ${retakeIndex + 1}`
                : `Ambil ${TOTAL_SHOTS} Foto Anda`}
            </StepTitle>
            <div
              className="text-center mt-3.5"
              style={{
                fontSize: 12,
                color: COLORS.muted,
                letterSpacing: "0.04em",
              }}
            >
              {retakeIndex !== null ? (
                <>
                  Mengganti{" "}
                  <b style={{ color: COLORS.goldSoft }}>
                    foto ke-{retakeIndex + 1}
                  </b>{" "}
                  saja
                </>
              ) : (
                <>
                  Foto ke{" "}
                  <b style={{ color: COLORS.goldSoft }}>
                    {Math.min(rawPhotos.length + 1, TOTAL_SHOTS)}
                  </b>{" "}
                  dari {TOTAL_SHOTS}
                </>
              )}
            </div>

            {/* toggle: cermin (mirrored, seperti yang terlihat di layar)
                vs asli (tidak dibalik) — mengunci begitu foto pertama
                diambil supaya keenam foto dalam satu sesi konsisten */}
            <div className="flex flex-col items-center mt-4.5">
              <div
                className="flex items-center justify-center gap-1 mx-auto"
                style={{
                  background: COLORS.bgSoft,
                  border: `1px solid ${COLORS.panelLine}`,
                  borderRadius: 999,
                  padding: 3,
                }}
              >
                {[
                  { id: true, label: "Cermin" },
                  { id: false, label: "Asli" },
                ].map((opt) => {
                  const active = mirrorCapture === opt.id;
                  const locked = rawPhotos.length > 0 || countdownRunning;
                  return (
                    <button
                      key={String(opt.id)}
                      onClick={() => !locked && setMirrorCapture(opt.id)}
                      disabled={locked}
                      title={
                        locked
                          ? "Mode kamera terkunci setelah foto pertama diambil"
                          : undefined
                      }
                      className="flex items-center gap-1.5 py-1.5 px-4"
                      style={{
                        background: active ? COLORS.gold : "transparent",
                        color: locked
                          ? COLORS.panelLine
                          : active
                            ? COLORS.ink
                            : COLORS.muted,
                        border: "none",
                        borderRadius: 999,
                        fontFamily: SANS,
                        fontSize: 11.5,
                        letterSpacing: "0.04em",
                        cursor: locked ? "not-allowed" : "pointer",
                        opacity: locked ? 0.6 : 1,
                      }}
                    >
                      <FlipHorizontal size={12} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p
                className="text-center mt-1.5"
                style={{
                  fontSize: 10.5,
                  color: COLORS.muted,
                  maxWidth: "30ch",
                }}
              >
                {mirrorCapture
                  ? "Hasil foto terbalik seperti cermin, sesuai tampilan di layar."
                  : "Hasil foto tidak dibalik — sesuai arah sebenarnya."}
              </p>
            </div>

            <div
              className="relative lg:w-150 shrink-0 aspect-3/4 md:aspect-16/10 mx-auto rounded-md mt-4.5"
              style={{
                background: "#000",
                overflow: "hidden",
                border: `1px solid ${COLORS.panelLine}`,
              }}
            >
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover block"
                style={{ transform: mirrorCapture ? "scaleX(-1)" : "none" }}
              />
              <div
                key={flashKey}
                className={`absolute inset-0 bg-white pointer-events-none opacity-0 ${flashKey > 0 ? "lb-flash-pop" : ""}`}
              />
              <div
                key={countdownKey}
                className={`absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 ${countdownDisplay ? "lb-cd-pop" : ""}`}
                style={{
                  fontFamily: SERIF,
                  fontSize: 96,
                  color: COLORS.goldSoft,
                  textShadow: "0 4px 30px rgba(0,0,0,.6)",
                }}
              >
                {countdownDisplay}
              </div>
              {showCamOverlay && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 text-center p-6"
                  style={{
                    background: "rgba(16,13,11,.92)",
                    color: COLORS.muted,
                    fontSize: 13,
                    lineHeight: 1.6,
                  }}
                >
                  <span>{camMsgText}</span>
                  {cameraStatus === "error" && (
                    <button
                      onClick={startCamera}
                      className="py-2.5 px-5 text-[13px] w-auto"
                      style={btnGhost}
                    >
                      Coba Lagi
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-1 justify-center mt-10">
              {Array.from({ length: TOTAL_SHOTS }).map((_, i) => {
                const filled = !!rawPhotos[i];
                const isRetakeTarget = retakeIndex === i;
                return (
                  <div
                    key={i}
                    className="w-15 h-15 flex items-center justify-center overflow-hidden shrink-0 relative"
                    style={{
                      border: isRetakeTarget
                        ? `1.5px solid ${COLORS.goldSoft}`
                        : filled
                          ? `1.5px solid ${COLORS.gold}`
                          : `1.5px dashed ${COLORS.panelLine}`,
                      background: COLORS.panel,
                      opacity:
                        retakeIndex !== null && !isRetakeTarget ? 0.45 : 1,
                    }}
                  >
                    {filled ? (
                      <img
                        src={rawPhotos[i].img.src}
                        alt={`shot ${i + 1}`}
                        className="w-full h-full object-cover block"
                      />
                    ) : (
                      <div
                        style={{
                          fontFamily: SERIF,
                          color: COLORS.muted,
                          fontSize: 15,
                        }}
                      >
                        {i + 1}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-auto pt-4">
              <button
                onClick={handleCaptureClick}
                disabled={
                  countdownRunning ||
                  cameraStatus !== "ready" ||
                  (retakeIndex === null && rawPhotos.length >= TOTAL_SHOTS)
                }
                className="w-full flex items-center justify-center gap-2 py-3 px-5.5 text-[13px] disabled:opacity-30 disabled:pointer-events-none active:opacity-90"
                style={btnSolid}
              >
                {retakeIndex !== null
                  ? "Ambil Foto Pengganti"
                  : rawPhotos.length >= TOTAL_SHOTS
                    ? "Semua Foto Terambil"
                    : "Ambil Foto"}
                {(retakeIndex !== null || rawPhotos.length < TOTAL_SHOTS) && (
                  <Camera size={16} />
                )}
              </button>
              {retakeIndex !== null && (
                <button
                  onClick={() => {
                    setRetakeIndex(null);
                    stopLiveClipRecording();
                    stopCamera();
                    setStep("review");
                  }}
                  className="w-full mt-2.5 py-2.5 text-[12px]"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: COLORS.muted,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}
                >
                  Batal, Kembali ke Hasil Foto
                </button>
              )}
            </div>
          </section>
        )}

        {/* ============ SCREEN: HASIL FOTO (review) ============ */}
        {step === "review" && (
          <section className="flex flex-col flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Langkah 4 dari {stepOrder.length}</StepEyebrow>
            <StepTitle>Sudah Sesuai?</StepTitle>
            <div className="flex flex-col items-center justify-center">
              <p
                className="text-center mx-auto mt-2.5"
                style={{
                  fontSize: 13.5,
                  lineHeight: 1.65,
                  color: COLORS.muted,
                  maxWidth: "34ch",
                }}
              >
                Periksa {TOTAL_SHOTS} foto Anda. Ambil ulang semua jika belum
                puas, atau lanjutkan ke pemilihan filter.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2.5 mt-5">
              {rawPhotos.map((rp, i) => (
                <div
                  key={i}
                  className="relative overflow-hidden group"
                  style={{
                    aspectRatio: "6 / 4",
                    border: `1px solid ${COLORS.panelLine}`,
                    background: COLORS.panel,
                  }}
                >
                  <img
                    src={rp.img.src}
                    alt={`hasil ${i + 1}`}
                    className="w-full h-full object-cover block"
                  />
                  <button
                    onClick={() => handleRetakeOne(i)}
                    className="absolute inset-0 flex flex-col items-center justify-center gap-1 active:opacity-90"
                    style={{
                      background: "rgba(16,13,11,0.55)",
                      border: "none",
                      color: COLORS.ivory,
                    }}
                    aria-label={`Ambil ulang foto ${i + 1}`}
                  >
                    <RotateCcw size={17} />
                    <span
                      style={{
                        fontFamily: SANS,
                        fontSize: 10,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                      }}
                    >
                      Ulangi
                    </span>
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-auto pt-6 flex gap-2.5">
              <button
                onClick={handleRetakeAll}
                className="flex-1 flex items-center justify-center gap-2 py-3 px-4.5 text-[12.5px] active:opacity-90"
                style={btnGhost}
              >
                <RotateCcw size={15} />
                Ambil Ulang
              </button>
              <button
                onClick={handleUsePhotos}
                className="flex-1 flex items-center justify-center gap-2 py-3 px-4.5 text-[12.5px] active:opacity-90"
                style={btnSolid}
              >
                Gunakan Foto
                <Check size={15} />
              </button>
            </div>
          </section>
        )}

        {/* ============ SCREEN 3: FILTER ============ */}
        {step === "filter" && (
          <section className="flex flex-col flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Langkah 5 dari {stepOrder.length}</StepEyebrow>
            <StepTitle>Pilih Filter</StepTitle>
            <div className="flex flex-col items-center justify-center">
              <p
                className="text-center w-full mx-auto mt-2.5"
                style={{
                  fontSize: 13.5,
                  lineHeight: 1.65,
                  color: COLORS.muted,
                  maxWidth: "34ch",
                }}
              >
                Filter akan diterapkan ke seluruh foto yang Anda ambil.
              </p>
            </div>

            <div
              className="w-full mt-4.5 shrink-0"
              style={{
                background: COLORS.bgSoft,
                border: `1px solid ${COLORS.panelLine}`,
                overflow: "hidden",
              }}
            >
              <canvas
                ref={filterPreviewCanvasRef}
                className="w-full h-auto block"
              />
            </div>

            <div className="flex gap-3 overflow-x-auto pt-4.5 px-0.5 pb-1.5 lb-scrollbar-none">
              {FILTERS.map((f) => {
                const active = f.id === filterId;
                return (
                  <button
                    key={f.id}
                    onClick={() => setFilterId(f.id)}
                    className="shrink-0 w-17.5 text-center"
                    style={{ background: "none", border: "none", padding: 0 }}
                  >
                    <canvas
                      ref={(el) => {
                        filterChipRefs.current[f.id] = el;
                      }}
                      width={140}
                      height={140}
                      className="w-17.5 h-17.5 object-cover block"
                      style={{
                        border: `2px solid ${active ? COLORS.gold : COLORS.panelLine}`,
                      }}
                    />
                    <div
                      className="mt-1.5 leading-tight"
                      style={{
                        fontSize: 10.5,
                        letterSpacing: "0.02em",
                        color: active ? COLORS.goldSoft : COLORS.muted,
                      }}
                    >
                      {f.name}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-auto pt-4">
              <button
                onClick={bakeFilterAndProceed}
                className="w-full flex items-center justify-center gap-2 py-3 px-5.5 text-[13px] active:opacity-90"
                style={btnSolid}
              >
                Lanjut ke Bingkai
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        )}

        {/* ============ SCREEN 4: FRAME / EDITOR ============ */}
        {step === "frame" && (
          <section className="flex flex-col flex-1 px-5 min-h-0">
            <StepEyebrow>Langkah 6 dari {stepOrder.length}</StepEyebrow>
            <StepTitle>Pilih Bingkai &amp; Foto</StepTitle>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="lg:w-100 w-50 flex items-center justify-center m-auto">
                <canvas
                  ref={mainCanvasRef}
                  className="lg:w-100 w-50 h-auto block m-auto"
                  style={{
                    touchAction: "none",
                    cursor: "grab",
                    margin: "auto",
                  }}
                />
              </div>
              <div>
                {/* <button
                  onClick={openBuilder}
                  className="w-full flex items-center justify-center gap-2 p-3 text-center cursor-pointer"
                  style={{
                    background: "transparent",
                    border: `1.5px dashed ${COLORS.gold}`,
                    color: COLORS.goldSoft,
                    borderRadius: "12px",
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-4 h-4"
                    style={{ stroke: COLORS.goldSoft }}
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <span style={{ fontSize: 12.5, letterSpacing: "0.06em" }}>
                    Buat Bingkai Sendiri
                  </span>
                </button> */}
                <div className="mt-5 flex flex-col gap-2.5 overflow-y-auto h-80 lg:h-150">
                  {templates.map((T) => {
                    const active = T.id === templateId;
                    return (
                      <button
                        key={T.id}
                        onClick={() => handleTemplateClick(T)}
                        className="w-full flex items-center gap-3 p-2.5 text-left cursor-pointer"
                        style={{
                          background: active
                            ? "rgba(17,17,17,0.06)"
                            : "transparent",
                          border: `1px solid ${active ? COLORS.gold : COLORS.panelLine}`,
                          borderRadius: "10px",
                        }}
                      >
                        <div
                          className="shrink-0 w-17.5 h-17.5 flex items-center justify-center overflow-hidden"
                          style={{
                            background: COLORS.bgSoft,
                            border: `1px solid ${COLORS.panelLine}`,
                          }}
                        >
                          <canvas
                            ref={(el) => {
                              templateChipRefs.current[T.id] = el;
                            }}
                            className="block"
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "contain",
                            }}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div
                            style={{
                              fontFamily: SERIF,
                              fontSize: 15.5,
                              color: active ? COLORS.goldSoft : COLORS.ivory,
                            }}
                          >
                            {T.name}
                          </div>
                          <div
                            className="mt-0.5 flex items-center gap-1.5"
                            style={{
                              fontSize: 11,
                              letterSpacing: "0.03em",
                              color: COLORS.muted,
                            }}
                          >
                            {T.meta}
                            {T.isCustom && (
                              <span
                                className="px-1.5 py-0.5"
                                style={{
                                  fontSize: 9,
                                  letterSpacing: "0.05em",
                                  color: COLORS.goldSoft,
                                  border: `1px solid ${COLORS.panelLine}`,
                                }}
                              >
                                SENDIRI
                              </span>
                            )}
                          </div>
                        </div>
                        {T.isCustom && (
                          <span
                            role="button"
                            onClick={(e) => handleDeleteCustomTemplate(e, T.id)}
                            className="shrink-0 p-2 cursor-pointer"
                            aria-label="Hapus bingkai"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="w-4 h-4"
                              style={{ stroke: COLORS.muted }}
                            >
                              <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-8 0 1 13a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-13" />
                            </svg>
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div
              className="text-center mt-2.5 leading-relaxed"
              style={{ fontSize: 11, color: COLORS.muted }}
            >
              Ketuk foto di galeri lalu ketuk kotak bingkai untuk{" "}
              <b style={{ color: COLORS.goldSoft, fontWeight: 500 }}>
                menempatkannya
              </b>
              . Seret untuk geser, cubit/gulir untuk memperbesar.
            </div>
            <div className="mt-4">
              <h3
                className="mb-2.5"
                style={{
                  fontSize: 11.5,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: COLORS.muted,
                  fontWeight: 500,
                }}
              >
                Galeri Foto Anda
              </h3>
              <div className="flex flex-wrap gap-2.5">
                {photos.map((p, idx) => {
                  const armed = armedPhotoIndex === idx;
                  return (
                    <div
                      key={idx}
                      onClick={() => handleGalleryClick(idx)}
                      className="w-14 h-14 overflow-hidden cursor-pointer shrink-0 relative"
                      style={{
                        border: `2px solid ${armed ? COLORS.gold : "transparent"}`,
                      }}
                    >
                      <img
                        src={p.url}
                        alt={`foto ${idx + 1}`}
                        className="w-full h-full object-cover block"
                      />
                      {armed && (
                        <div
                          className="absolute inset-0 flex items-center justify-center text-white"
                          style={{
                            background: "rgba(198,162,92,.3)",
                            fontSize: 16,
                          }}
                        >
                          ✓
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div
              className="mt-4.5 p-4"
              style={{
                background: COLORS.panel,
                border: `1px solid ${COLORS.panelLine}`,
              }}
            >
              <h3
                className="mb-3"
                style={{
                  fontSize: 11.5,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: COLORS.muted,
                  fontWeight: 500,
                }}
              >
                Slot Aktif
              </h3>
              {activeSlotIndex === null ||
              !activeSlotState ||
              activeSlotState.photoIndex === null ? (
                <div
                  style={{
                    fontSize: 12.5,
                    color: COLORS.muted,
                    fontStyle: "italic",
                    lineHeight: 1.6,
                  }}
                >
                  Ketuk salah satu kotak foto pada bingkai untuk mengatur
                  posisinya di sini.
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between gap-2.5 mb-2.5">
                    <label style={{ fontSize: 12, color: COLORS.muted }}>
                      Perbesar
                    </label>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="3"
                    step="0.01"
                    value={activeSlotState.zoom}
                    onChange={handleZoomChange}
                    className="lb-range w-full"
                  />
                  <div className="flex gap-2 mt-1">
                    <button
                      onClick={handleResetPos}
                      className="flex-1 py-2 px-2.5 text-[10.5px]"
                      style={btnGhost}
                    >
                      Reset Posisi
                    </button>
                    <button
                      onClick={handleClearSlot}
                      className="flex-1 py-2 px-2.5 text-[10.5px]"
                      style={btnGhost}
                    >
                      Kosongkan
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="mt-5">
              <button
                onClick={() =>
                  setStep(hasFramedLiveClip() ? "preparingPreview" : "preview")
                }
                className="w-full flex items-center justify-center gap-2 py-3 px-5.5 text-[13px] active:opacity-90"
                style={btnSolid}
              >
                Lanjut ke Preview
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        )}

        {/* ============ SCREEN: MENYIAPKAN BINGKAI + LIVE ============
            transitional loading screen between "frame" and the final
            preview — keeps the guest here until the combined Bingkai +
            Live GIF has finished building, instead of showing it half
            ready on the preview screen. */}
        {step === "preparingPreview" && (
          <section className="flex flex-col flex-1 items-center justify-center px-5 pt-6.5 pb-7 min-h-0">
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                border: `3px solid ${COLORS.panelLine}`,
                borderTopColor: COLORS.gold,
                animation: "lb-spin 0.8s linear infinite",
              }}
            />
            <style>{`@keyframes lb-spin { to { transform: rotate(360deg); } }`}</style>
            <StepTitle>Menyusun Bingkai + Live View</StepTitle>
            <p
              className="text-center mx-auto mt-2.5"
              style={{
                fontSize: 13.5,
                lineHeight: 1.65,
                color: COLORS.muted,
                maxWidth: 280,
              }}
            >
              Mohon tunggu sebentar, sedang menggabungkan bingkai dengan live
              view setiap foto…
            </p>
          </section>
        )}

        {/* ============ SCREEN: PREVIEW AKHIR ============ */}
        {step === "preview" && (
          <section className="flex flex-col flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Langkah 7 dari {stepOrder.length}</StepEyebrow>
            <StepTitle>Foto + Filter + Bingkai</StepTitle>
            <div className="flex flex-col items-center justify-center">
              <p
                className="text-center mx-auto mt-2.5"
                style={{
                  fontSize: 13.5,
                  lineHeight: 1.65,
                  color: COLORS.muted,
                }}
              >
                Ini tampilan akhir hasil foto Anda. Simpan jika sudah sesuai,
                atau kembali untuk mengubahnya.
              </p>
            </div>

            {/* toggle: bingkai (framed, composited) vs bingkai + live
                (same layout, every slot playing its live clip) —
                determines what's shown below and which version gets
                downloaded when "Simpan" is pressed */}
            <div
              className="flex items-center justify-center gap-1 mt-4.5 mx-auto"
              style={{
                background: COLORS.bgSoft,
                border: `1px solid ${COLORS.panelLine}`,
                borderRadius: 999,
                padding: 3,
              }}
            >
              {[
                { id: "framed", label: "Dengan Bingkai" },
                { id: "framed-live", label: "Bingkai + Live" },
              ].map((v) => {
                const active = previewVariant === v.id;
                const disabled =
                  v.id === "framed-live" && !hasFramedLiveClip();
                return (
                  <button
                    key={v.id}
                    onClick={() => !disabled && setPreviewVariant(v.id)}
                    disabled={disabled}
                    title={
                      disabled
                        ? "Belum ada rekaman bingkai + live untuk foto ini"
                        : undefined
                    }
                    className="py-1.5 px-4"
                    style={{
                      background: active ? COLORS.gold : "transparent",
                      color: disabled
                        ? COLORS.panelLine
                        : active
                          ? COLORS.ink
                          : COLORS.muted,
                      border: "none",
                      borderRadius: 999,
                      fontFamily: SANS,
                      fontSize: 11.5,
                      letterSpacing: "0.04em",
                      cursor: disabled ? "not-allowed" : "pointer",
                      opacity: disabled ? 0.6 : 1,
                    }}
                  >
                    {v.label}
                  </button>
                );
              })}
            </div>

            <div
              className="mt-3.5 p-3.5"
              style={{
                background: COLORS.panel,
                border: `1px solid ${COLORS.panelLine}`,
              }}
            >
              <div
                className="w-full flex items-center justify-center"
                style={{ background: COLORS.bgSoft }}
              >
                <canvas
                  ref={previewCanvasRef}
                  className="w-full h-auto block"
                  style={{
                    display: previewVariant === "framed" ? "block" : "none",
                  }}
                />
                {previewVariant === "framed-live" &&
                  (framedLiveGifUrl ? (
                    <img
                      key={framedLiveGifUrl}
                      src={framedLiveGifUrl}
                      alt="Bingkai dengan live view hasil foto"
                      className="w-full h-auto block"
                    />
                  ) : (
                    <div
                      className="w-full py-14 text-center px-4"
                      style={{ fontSize: 12, color: COLORS.muted }}
                    >
                      {framedLiveGifGenerating
                        ? "Menyusun bingkai + live view yang berputar terus…"
                        : "Belum ada rekaman live view untuk foto pada bingkai ini."}
                    </div>
                  ))}
              </div>
            </div>
            <p
              className="text-center mt-2.5"
              style={{ fontSize: 11, color: COLORS.muted }}
            >
              {previewVariant === "framed-live"
                ? framedLiveGifUrl
                  ? "GIF bingkai lengkap — layout sama seperti versi Dengan Bingkai, setiap foto di dalamnya berputar terus sebagai live view."
                  : "Menyusun GIF bingkai lengkap dengan live view di setiap slot foto."
                : "Foto dengan filter di dalam bingkai pilihan Anda."}
            </p>

            <div className="mt-auto pt-6 flex gap-2.5">
              <button
                onClick={() => setStep("frame")}
                className="flex-1 py-3 px-4.5 text-[12.5px] active:opacity-90"
                style={btnGhost}
              >
                Ubah
              </button>
              <button
                onClick={handleSaveAndFinish}
                className="flex-1 flex items-center justify-center gap-2 py-3 px-4.5 text-[12.5px] active:opacity-90"
                style={btnSolid}
              >
                Simpan
                <Check size={15} />
              </button>
            </div>
          </section>
        )}

        {/* ============ SCREEN: SELESAI ============ */}
        {step === "done" && (
          <section className="flex flex-col flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Selesai</StepEyebrow>
            <StepTitle>Terima Kasih!</StepTitle>

            <div
              className="flex flex-col items-center gap-3 mt-6 mx-auto w-full py-7"
              style={{
                maxWidth: 260,
                background: COLORS.panel,
                border: `1px solid ${COLORS.panelLine}`,
              }}
            >
              <div className="p-3" style={{ background: COLORS.ivory }}>
                <DummyQR seed={`astar-booth-file-${templateId}`} size={172} />
              </div>
              <div className="flex items-center gap-1.5">
                <QrCode size={14} color={COLORS.goldSoft} />
                <span style={{ fontSize: 12, color: COLORS.ivoryDim }}>
                  Scan untuk mengunduh foto kamu
                </span>
              </div>
              <span
                style={{
                  fontSize: 10.5,
                  color: COLORS.muted,
                  letterSpacing: "0.04em",
                }}
              >
                Berlaku 24 jam · astarbooth.id/f
              </span>
            </div>

            <p
              className="text-center mt-4"
              style={{ fontSize: 11.5, color: COLORS.muted }}
            >
              Pilih salah satu tombol di bawah untuk mengunduh hasil foto Anda
              ke perangkat.
            </p>

            <div className="grid grid-cols-2 gap-2.5 mt-3">
              <button
                onClick={handleDownload}
                className="py-2.5 px-4 text-[11.5px] active:opacity-90"
                style={btnGhost}
              >
                Unduh Versi Bingkai
              </button>
              <button
                onClick={handleDownloadFramedLive}
                disabled={!framedLiveGifUrl}
                className="py-2.5 px-4 text-[11.5px] active:opacity-90 disabled:opacity-40 disabled:pointer-events-none"
                style={btnGhost}
              >
                Unduh Bingkai + Live
              </button>
              <button
                onClick={handleDownloadAllPhotos}
                disabled={photos.length === 0}
                className="py-2.5 px-4 text-[11.5px] active:opacity-90 disabled:opacity-40 disabled:pointer-events-none"
                style={btnGhost}
              >
                Unduh Semua Foto ({photos.length})
              </button>
              <button
                onClick={handleDownloadLiveView}
                disabled={liveClipsAvailableCount() === 0}
                className="py-2.5 px-4 text-[11.5px] active:opacity-90 disabled:opacity-40 disabled:pointer-events-none"
                style={btnGhost}
              >
                Unduh Semua Live View ({liveClipsAvailableCount()})
              </button>
            </div>

            <button
              onClick={openPrintFlow}
              className="w-full mt-2.5 flex items-center justify-center gap-2 py-2.5 px-4 text-[11.5px] active:opacity-90"
              style={btnGhost}
            >
              Tambah Cetak Foto
              <Printer size={14} />
            </button>

            <div className="mt-auto pt-6">
              <button
                onClick={fullReset}
                className="w-full flex items-center justify-center gap-2 py-3 px-5.5 text-[13px] active:opacity-90"
                style={btnSolid}
              >
                Foto Lagi
                <RotateCcw size={16} />
              </button>
            </div>
          </section>
        )}

        {/* ============ SCREEN: CETAK — JUMLAH LEMBAR ============ */}
        {step === "printQty" && (
          <section className="flex flex-col flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Cetak Foto</StepEyebrow>
            <StepTitle>Berapa Lembar?</StepTitle>
            <p
              className="text-center mx-auto mt-2.5"
              style={{
                fontSize: 13.5,
                lineHeight: 1.65,
                color: COLORS.muted,
                maxWidth: "34ch",
              }}
            >
              Pilih jumlah lembar cetak yang Anda inginkan. Setiap lembar berisi
              hasil foto lengkap dengan bingkai pilihan Anda.
            </p>

            <div
              className="mt-5 mx-auto w-full flex items-center justify-center p-3"
              style={{
                maxWidth: 220,
                background: COLORS.panel,
                border: `1px solid ${COLORS.panelLine}`,
              }}
            >
              {printImageUrl && (
                <img
                  src={printImageUrl}
                  alt="Pratinjau cetak"
                  className="w-full h-auto block"
                />
              )}
            </div>

            <div className="flex items-center justify-center gap-5 mt-7">
              <button
                onClick={() => setPrintQty((q) => Math.max(1, q - 1))}
                className="w-11 h-11 flex items-center justify-center"
                style={btnGhost}
              >
                −
              </button>
              <span
                style={{
                  fontFamily: SERIF,
                  fontSize: 28,
                  color: COLORS.goldSoft,
                  minWidth: 40,
                  textAlign: "center",
                }}
              >
                {printQty}
              </span>
              <button
                onClick={() =>
                  setPrintQty((q) => Math.min(PRINT_QTY_MAX, q + 1))
                }
                className="w-11 h-11 flex items-center justify-center"
                style={btnGhost}
              >
                +
              </button>
            </div>
            <p
              className="text-center mt-2"
              style={{ fontSize: 10.5, color: COLORS.muted }}
            >
              Maks. {PRINT_QTY_MAX} lembar per sesi
            </p>

            <div className="flex flex-col items-center mt-6">
              <span
                style={{
                  fontSize: 11.5,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: COLORS.muted,
                }}
              >
                Total Bayar
              </span>
              <span
                style={{
                  fontFamily: SERIF,
                  fontSize: 22,
                  color: COLORS.goldSoft,
                }}
              >
                Rp {(printQty * PRINT_PRICE_PER_COPY).toLocaleString("id-ID")}
              </span>
              <span
                style={{ fontSize: 10.5, color: COLORS.muted, marginTop: 2 }}
              >
                Rp {PRINT_PRICE_PER_COPY.toLocaleString("id-ID")} / lembar
              </span>
            </div>

            <div className="mt-auto pt-6 flex gap-2.5">
              <button
                onClick={() => setStep("done")}
                className="flex-1 py-3 px-4.5 text-[12.5px] active:opacity-90"
                style={btnGhost}
              >
                Batal
              </button>
              <button
                onClick={() => setStep("printPayment")}
                className="flex-1 flex items-center justify-center gap-2 py-3 px-4.5 text-[12.5px] active:opacity-90"
                style={btnSolid}
              >
                Lanjut Bayar
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        )}

        {/* ============ SCREEN: CETAK — PEMBAYARAN QRIS ============ */}
        {step === "printPayment" && (
          <section className="flex flex-col flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Cetak Foto</StepEyebrow>
            <StepTitle>Scan QRIS untuk Cetak</StepTitle>
            <p
              className="w-full text-center mx-auto mt-2.5"
              style={{
                fontSize: 13.5,
                lineHeight: 1.65,
                color: COLORS.muted,
              }}
            >
              Pindai kode di bawah ini untuk membayar {printQty} lembar cetak.
              Foto akan otomatis dikirim ke printer setelah pembayaran selesai.
            </p>

            <div
              className="flex flex-col items-center mt-6 mx-auto w-full"
              style={{
                maxWidth: 300,
                background: COLORS.ivory,
                border: `1px solid ${COLORS.panelLine}`,
                padding: "22px 18px",
              }}
            >
              <div
                className="flex items-center justify-between w-full mb-4"
                style={{ fontFamily: SANS }}
              >
                <span
                  style={{
                    fontFamily: SERIF,
                    fontStyle: "italic",
                    fontSize: 17,
                    color: COLORS.ink,
                  }}
                >
                  Astár Booth
                </span>
                <span
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.14em",
                    color: "#8a8a8a",
                    fontWeight: 600,
                  }}
                >
                  QRIS
                </span>
              </div>
              <DummyQR seed={`astar-booth-print-${printQty}`} size={188} />
              <div
                className="mt-4 text-center"
                style={{
                  fontSize: 11,
                  color: "#8a8a8a",
                  letterSpacing: "0.04em",
                }}
              >
                NMID · ID10256987654 · Astár Booth
              </div>
            </div>

            <div
              className="flex flex-col items-center justify-between mt-5 mx-auto w-full"
              style={{ maxWidth: 300 }}
            >
              <span
                style={{
                  fontSize: 11.5,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: COLORS.muted,
                }}
              >
                Total Bayar · {printQty} Lembar
              </span>
              <span
                style={{
                  fontFamily: SERIF,
                  fontSize: 20,
                  color: COLORS.goldSoft,
                }}
              >
                Rp {(printQty * PRINT_PRICE_PER_COPY).toLocaleString("id-ID")}
              </span>
            </div>

            <div className="flex flex-col items-center justify-between mt-3">
              <p
                className="text-center"
                style={{ fontSize: 11, color: COLORS.muted, maxWidth: "34ch" }}
              >
                *Simulasi pembayaran (dummy). Tidak ada transaksi nyata yang
                diproses.
              </p>
            </div>

            <div className="mt-auto pt-5.5 flex gap-2.5">
              <button
                onClick={() => setStep("printQty")}
                className="flex-1 py-3 px-4.5 text-[12.5px] active:opacity-90"
                style={btnGhost}
              >
                Kembali
              </button>
              <button
                onClick={handlePrint}
                className="flex-1 flex items-center justify-center gap-2 py-3 px-4.5 text-[13px] active:opacity-90"
                style={btnSolid}
              >
                Sudah Bayar, Cetak
                <Printer size={16} />
              </button>
            </div>
          </section>
        )}

        {/* ============ SCREEN: CETAK — SEDANG DICETAK ============ */}
        {step === "printDone" && (
          <section className="flex flex-col flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Cetak Foto</StepEyebrow>
            <StepTitle>Sedang Mencetak…</StepTitle>
            <div
              className="flex flex-col items-center gap-3 mt-6 mx-auto w-full py-8"
              style={{
                maxWidth: 260,
                background: COLORS.panel,
                border: `1px solid ${COLORS.panelLine}`,
              }}
            >
              <Printer size={34} color={COLORS.goldSoft} />
              <p
                className="text-center"
                style={{
                  fontSize: 12.5,
                  color: COLORS.ivoryDim,
                  lineHeight: 1.6,
                }}
              >
                {printQty} lembar foto Anda sedang dikirim ke printer.
              </p>
            </div>

            <div className="mt-auto pt-6 flex flex-col gap-2.5">
              <button
                onClick={openPrintFlow}
                className="w-full py-3 px-5.5 text-[13px] active:opacity-90"
                style={btnGhost}
              >
                Cetak Lagi
              </button>
              <button
                onClick={() => setStep("done")}
                className="w-full flex items-center justify-center gap-2 py-3 px-5.5 text-[13px] active:opacity-90"
                style={btnSolid}
              >
                Selesai
                <Check size={16} />
              </button>
            </div>
          </section>
        )}

        <footer
          className="flex items-center justify-center gap-3 px-4.5 pt-3.5 pb-4 shrink-0"
          style={{ borderTop: `1px solid ${COLORS.panelLine}` }}
        >
          <svg
            viewBox="0 0 40 40"
            className="w-4.5 h-4.5 shrink-0"
            style={{ opacity: 0.8 }}
            fill="none"
          >
            <path
              d="M20 8c8 0 14 8 14 16H6c0-8 6-16 14-16Z"
              stroke="#111111"
              strokeWidth="2.2"
              strokeLinejoin="round"
            />
            <path
              d="M20 10v14M14 12v12M26 12v12"
              stroke="#111111"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          <p
            className="text-center"
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: COLORS.muted,
            }}
          >
            Astár Booth — kenangan yang layak dibingkai
          </p>
          <svg
            viewBox="0 0 40 40"
            className="w-4.5 h-4.5 shrink-0"
            style={{ opacity: 0.8 }}
            fill="none"
          >
            <circle cx="20" cy="9" r="3" stroke="#111111" strokeWidth="2.2" />
            <path
              d="M20 12v20M12 20h16"
              stroke="#111111"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <path
              d="M12 24c0 5 4 8 8 8s8-3 8-8"
              stroke="#111111"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </footer>

        {/* ============ CUSTOM FRAME BUILDER OVERLAY ============ */}
        {builderOpen && (
          <div
            className="absolute inset-0 flex flex-col overflow-y-auto"
            style={{ background: COLORS.bg, zIndex: 20 }}
          >
            <div
              className="flex items-center justify-between px-4.5 py-4 shrink-0"
              style={{ borderBottom: `1px solid ${COLORS.panelLine}` }}
            >
              <span
                style={{ fontFamily: SERIF, fontSize: 18, color: COLORS.ivory }}
              >
                Buat Bingkai Sendiri
              </span>
              <button
                onClick={closeBuilder}
                className="p-1.5"
                style={{
                  background: "transparent",
                  border: "none",
                  color: COLORS.muted,
                  borderRadius: "8px",
                }}
                aria-label="Tutup"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                  style={{ stroke: COLORS.muted }}
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-5 py-5 flex flex-col gap-5">
              {/* live preview */}
              <div
                className="w-full flex items-center justify-center p-4"
                style={{
                  background: COLORS.panel,
                  border: `1px solid ${COLORS.panelLine}`,
                }}
              >
                <canvas
                  ref={builderPreviewRef}
                  className="max-h-55 max-w-full"
                  style={{ objectFit: "contain" }}
                />
              </div>

              {/* name */}
              <div>
                <label
                  className="block mb-1.5"
                  style={{
                    fontSize: 11.5,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: COLORS.muted,
                  }}
                >
                  Nama Bingkai
                </label>
                <input
                  type="text"
                  value={builderName}
                  maxLength={30}
                  onChange={(e) => setBuilderName(e.target.value)}
                  placeholder="Bingkai Saya"
                  className="w-full py-2.5 px-3 outline-none"
                  style={{
                    background: COLORS.panel,
                    border: `1px solid ${COLORS.panelLine}`,
                    color: COLORS.ivory,
                    fontFamily: SANS,
                    fontSize: 13.5,
                  }}
                />
              </div>

              <>
                {/* upload frame image */}
                <div>
                  <label
                    className="block mb-1.5"
                    style={{
                      fontSize: 11.5,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: COLORS.muted,
                    }}
                  >
                    Gambar Bingkai (PNG Transparan)
                  </label>
                  <label
                    className="w-full flex items-center justify-center gap-2 py-3 px-3 cursor-pointer"
                    style={{
                      background: "transparent",
                      border: `1.5px dashed ${COLORS.gold}`,
                      color: COLORS.goldSoft,
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-4 h-4"
                      style={{ stroke: COLORS.goldSoft }}
                    >
                      <path d="M12 16V4m0 0 4 4m-4-4-4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                    </svg>
                    <span style={{ fontSize: 12.5 }}>
                      {builderImageFile ? "Ganti Gambar" : "Pilih Gambar"}
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleBuilderImageSelect}
                      className="hidden"
                    />
                  </label>
                  {builderImageFile && (
                    <div
                      className="mt-1.5"
                      style={{ fontSize: 11, color: COLORS.muted }}
                    >
                      {builderImageFile.width} × {builderImageFile.height}px
                      {builderImageFile.hasHole && (
                        <>
                          {" "}
                          · area foto terdeteksi {builderImageFile.holeW} ×{" "}
                          {builderImageFile.holeH}px
                        </>
                      )}
                    </div>
                  )}
                  {builderImageError && (
                    <div
                      className="mt-1.5"
                      style={{ fontSize: 11, color: "#d98a6b" }}
                    >
                      {builderImageError}
                    </div>
                  )}
                  <p
                    className="mt-2"
                    style={{
                      fontSize: 11,
                      lineHeight: 1.5,
                      color: COLORS.muted,
                    }}
                  >
                    Unggah gambar bingkai PNG transparan. Area transparan pada
                    PNG terdeteksi otomatis, dan foto akan langsung terisi
                    mengikuti area itu — bingkai ini menjadi tampilan akhir
                    foto.
                  </p>
                </div>

                {/* how many photos this template's holes are meant for */}
                <div>
                  <label
                    className="block mb-1.5"
                    style={{
                      fontSize: 11.5,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: COLORS.muted,
                    }}
                  >
                    Jumlah Foto pada Templat Ini
                  </label>
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => setBuilderCount((c) => Math.max(1, c - 1))}
                      className="w-10 h-10 flex items-center justify-center"
                      style={btnGhost}
                    >
                      −
                    </button>
                    <span
                      style={{
                        fontFamily: SERIF,
                        fontSize: 22,
                        color: COLORS.goldSoft,
                        minWidth: 24,
                        textAlign: "center",
                      }}
                    >
                      {builderCount}
                    </span>
                    <button
                      onClick={() => setBuilderCount((c) => Math.min(6, c + 1))}
                      className="w-10 h-10 flex items-center justify-center"
                      style={btnGhost}
                    >
                      +
                    </button>
                  </div>
                  <p
                    className="mt-2"
                    style={{
                      fontSize: 11,
                      lineHeight: 1.5,
                      color: COLORS.muted,
                    }}
                  >
                    {builderImageFile && builderImageFile.hasHole
                      ? builderImageFile.holes.length === builderCount
                        ? `Cocok — ${builderImageFile.holes.length} area transparan terpisah terdeteksi, tiap foto akan pas di lubangnya masing-masing.`
                        : `${builderImageFile.holes.length} area transparan terdeteksi. Karena jumlahnya beda dari ${builderCount}, area foto akan dibagi rata sebanyak ${builderCount} bagian.`
                      : "Beri tahu ada berapa foto di templat ini, supaya jumlah & urutan foto yang diminta cocok dengan desain bingkainya."}
                  </p>
                </div>
              </>
            </div>

            <div className="mt-auto px-5 pb-6 pt-2 flex gap-2.5">
              <button
                onClick={closeBuilder}
                className="flex-1 py-2.75 text-[12.5px]"
                style={btnGhost}
              >
                Batal
              </button>
              <button
                onClick={handleSaveCustomTemplate}
                className="flex-1 py-2.75 text-[12.5px]"
                style={btnSolid}
              >
                Simpan Bingkai
              </button>
            </div>
          </div>
        )}

        {/* ============ AREA CETAK (tersembunyi, hanya tampil saat print) ============
            Diulang sebanyak printQty agar satu kali window.print() langsung
            menghasilkan jumlah lembar yang diminta pengguna. */}
        <div id="lb-print-area">
          {printImageUrl &&
            Array.from({ length: printQty }).map((_, i) => (
              <div className="lb-print-page" key={i}>
                <img src={printImageUrl} alt={`Cetak ${i + 1}`} />
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}