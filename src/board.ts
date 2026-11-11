import type { Board, Pad } from "./types.ts";

type Loose = Record<string, unknown>;

function asRecord(value: unknown): Loose | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Loose;
  return null;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function netName(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const rec = asRecord(value);
  if (!rec) return "";
  return asString(rec.name ?? rec.net ?? rec.netName);
}

function padFrom(raw: unknown, refHint: string): Pad | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const ref = asString(rec.ref ?? rec.reference ?? rec.designator ?? refHint);
  const pad = asString(rec.pad ?? rec.padName ?? rec.padNumber ?? rec.number ?? rec.name ?? rec.pin);
  const net = netName(rec.net ?? rec.netName);
  if (!ref || !net) return null;
  const padOut: Pad = { ref, pad, net };
  const at = Array.isArray(rec.at) ? rec.at : null;
  const x = asNumber(rec.x ?? rec.xMm ?? rec.x_mm ?? at?.[0]);
  const y = asNumber(rec.y ?? rec.yMm ?? rec.y_mm ?? at?.[1]);
  if (x !== undefined) padOut.x = x;
  if (y !== undefined) padOut.y = y;
  return padOut;
}

function padsFromFootprints(list: unknown): Pad[] {
  if (!Array.isArray(list)) return [];
  const pads: Pad[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const ref = asString(rec.ref ?? rec.reference ?? rec.designator);
    const nested = rec.pads ?? rec.pins;
    if (Array.isArray(nested)) {
      for (const pin of nested) {
        const pad = padFrom(pin, ref);
        if (pad) pads.push(pad);
      }
    } else {
      const pad = padFrom(rec, ref);
      if (pad) pads.push(pad);
    }
  }
  return pads;
}

/** Accept a flat pad list or a footprint/component tree from /board or export.json. */
export function normalizeBoard(raw: unknown): Board {
  const rec = asRecord(raw);
  if (!rec) return { pads: [] };
  const direct = rec.pads ?? rec.padList;
  if (Array.isArray(direct)) {
    const pads = direct.map((item) => padFrom(item, "")).filter((pad): pad is Pad => pad !== null);
    if (pads.length > 0) return { pads };
  }
  const nested = padsFromFootprints(rec.footprints ?? rec.components ?? rec.modules ?? rec.pads);
  if (nested.length > 0) return { pads: nested };
  const inner = asRecord(rec.board);
  if (inner) return normalizeBoard(inner);
  return { pads: [] };
}

export function targetOf(pad: Pad): string {
  return pad.pad ? `${pad.ref}.${pad.pad}` : pad.ref;
}

export function findPad(board: Board, target: string, net?: string): Pad | undefined {
  const want = target.trim();
  const hits = board.pads.filter((pad) => {
    if (targetOf(pad) !== want && pad.ref !== want) return false;
    if (net && pad.net !== net) return false;
    return true;
  });
  return hits[0];
}

export function nets(board: Board): string[] {
  const seen = new Set<string>();
  for (const pad of board.pads) seen.add(pad.net);
  return [...seen];
}

export type NetClass = "ground" | "power" | "clock" | "reset" | "bus" | "other";

export function netClass(net: string): NetClass {
  const n = net.toUpperCase();
  if (/GND|VSS|AGND|DGND/.test(n)) return "ground";
  if (/SWDIO|SWCLK|SWO|\bSWD\b|JTCK|JTMS|JTDO|JTDI/.test(n)) return "bus";
  if (/SDA|SCL|I2C|MOSI|MISO|\bSCK\b|\bSPI\b|UART|USART|\bTX\b|\bRX\b|\bCAN\b|USB|DP|DM/.test(n)) return "bus";
  if (/NRST|NRESET|RESET|\bRST\b|\bPOR\b/.test(n)) return "reset";
  if (/HSE|LSE|OSC|XTAL|MCO|CLOCK|\bCLK\b/.test(n)) return "clock";
  if (railNominal(net) !== null || /VDD|VCC|VBUS|VBAT|\bVIN\b/.test(n)) return "power";
  return "other";
}

/** Volts implied by the net name, or null when the name has no number. Ground is 0. */
export function railNominal(net: string): number | null {
  const n = net.toUpperCase();
  if (/GND|VSS/.test(n) && !/\d/.test(n)) return 0;
  const split = n.match(/(\d+)\s*V\s*(\d+)/);
  if (split) return Number(split[1]) + Number(split[2]) / 10 ** split[2].length;
  const whole = n.match(/(\d+(?:\.\d+)?)\s*V\b/);
  if (whole) return Number(whole[1]);
  if (/VBUS|\bVIN\b/.test(n)) return 5;
  return null;
}

export function padsOn(board: Board, net: string): Pad[] {
  return board.pads.filter((pad) => pad.net === net);
}

function score(pad: Pad, stage: "power" | "clock" | "reset" | "bus" | "ground"): number {
  const ref = pad.ref.toUpperCase();
  if (/^TP/.test(ref)) return 0;
  if (stage === "clock" && /^[YX]\d/.test(ref)) return 1;
  if (/^(J|P|CN)\d/.test(ref)) return 2;
  if (/^[RC]\d/.test(ref)) return 3;
  if (/^U\d/.test(ref)) return 5;
  return 4;
}

export function pickPad(board: Board, net: string, stage: "power" | "clock" | "reset" | "bus" | "ground"): Pad | undefined {
  const pads = padsOn(board, net);
  if (pads.length === 0) return undefined;
  return [...pads].sort((a, b) => {
    const byScore = score(a, stage) - score(b, stage);
    if (byScore !== 0) return byScore;
    const byRef = a.ref.localeCompare(b.ref);
    if (byRef !== 0) return byRef;
    return a.pad.localeCompare(b.pad, undefined, { numeric: true });
  })[0];
}

export function kindFor(ref: string): "probe" | "connector" | "button" | "pin1" {
  if (/^(J|P|CN)\d/i.test(ref)) return "connector";
  if (/^(SW|BTN)\d/i.test(ref)) return "button";
  return "probe";
}
