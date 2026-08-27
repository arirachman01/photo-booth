import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Camera,
  Check,
  RotateCcw,
  ArrowRight,
  AlertCircle,
  QrCode,
  Sparkles,
} from "lucide-react";

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
      ...customTemplates.map((spec) =>
        buildCustomTemplate(spec, () => setAssetTick((t) => t + 1)),
      ),
    ],
    [customTemplates],
  );

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    startCamera();
    return () => {
      stopCamera();
    };
  }, [step, startCamera]);

  /* ================= reset ================= */
  function fullReset() {
    stopCamera();
    setRawPhotos([]);
    setPhotos([]);
    setFilterId("normal");
    setTemplateId(BUILTIN_TEMPLATES[0].id);
    setSlotStates([]);
    setArmedPhotoIndex(null);
    setActiveSlotIndex(null);
    setRetakeIndex(null);
    setStep("start");
  }

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
    wctx.translate(vw, 0);
    wctx.scale(-1, 1);
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

  function handleDownload() {
    const T = currentTemplate();
    const off = document.createElement("canvas");
    off.width = T.width * RES;
    off.height = T.height * RES;
    drawComposition(off, true);
    const link = document.createElement("a");
    link.download = `Astâr-booth-${T.id}.png`;
    link.href = off.toDataURL("image/png");
    link.click();
  }

  function handleSaveAndFinish() {
    handleDownload();
    setStep("done");
  }

  /* ================= custom frame builder ================= */
  const MAX_FRAME_IMG_DIM = 1600;
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
      `}</style>

      <div
        className="w-full max-w-220 min-h-dvh lg:min-h-200 flex flex-col relative md:rounded-2xl md:overflow-hidden"
        style={{ background: COLORS.bg, boxShadow: "0 0 60px rgba(0,0,0,.12)" }}
      >
        {/* ============ DEKORASI SUDUT BERTEMA LAUT ============ */}
        {/* ombak — pojok kiri atas */}
        <svg
          viewBox="0 0 40 40"
          className="absolute top-3 left-3 w-6 h-6 pointer-events-none"
          style={{ opacity: 0.85, zIndex: 5 }}
          fill="none"
        >
          <path
            d="M3 15c3-4 7-4 10 0s7 4 10 0 7-4 10 0"
            stroke="#111111"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M3 23c3-4 7-4 10 0s7 4 10 0 7-4 10 0"
            stroke="#111111"
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.5"
          />
        </svg>

        {/* ikan kecil — pojok kanan atas */}
        <svg
          viewBox="0 0 40 40"
          className="absolute top-3 right-3 w-6 h-6 pointer-events-none"
          style={{ opacity: 0.85, zIndex: 5 }}
          fill="none"
        >
          <path
            d="M8 20c4-6 14-8 20-4-2 2-2 6 0 8-6 4-16 2-20-4Z"
            fill="#111111"
          />
          <path d="M8 20 3 16v8l5-4Z" fill="#111111" />
          <circle cx="23" cy="18" r="1.3" fill="#ffffff" />
        </svg>

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
                onClick={() => setStep("permission")}
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

            <div
              className="relative lg:w-150 shrink-0 aspect-3/4 md:aspect-16/10 mx-auto rounded-md"
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
                style={{ transform: "scaleX(-1)" }}
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
          <section className="flex flex-col flex-1 px-5 pt-6.5 pb-7 min-h-0">
            <StepEyebrow>Langkah 6 dari {stepOrder.length}</StepEyebrow>
            <StepTitle>Pilih Bingkai &amp; Foto</StepTitle>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div
                className="p-3.5"
                style={{
                  background: COLORS.panel,
                  border: `1px solid ${COLORS.panelLine}`,
                }}
              >
                <div
                  className="lg:w-100 w-50 flex items-center justify-center m-auto"
                  style={{ background: COLORS.bgSoft }}
                >
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
              </div>

              <div className="flex flex-col gap-2.5 pt-4 pb-4 overflow-y-auto h-80 lg:h-dvh">
                <button
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
                </button>

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
                onClick={() => setStep("preview")}
                className="w-full flex items-center justify-center gap-2 py-3 px-5.5 text-[13px] active:opacity-90"
                style={btnSolid}
              >
                Lanjut ke Preview
                <ArrowRight size={16} />
              </button>
            </div>
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

            <div
              className="mt-5 p-3.5"
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
                />
              </div>
            </div>

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
      </div>
    </div>
  );
}
